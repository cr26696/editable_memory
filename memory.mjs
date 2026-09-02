#!/usr/bin/env node
/**
 * memory — AI 长期记忆 CLI（零依赖，Node >= 18）
 * 程序化实现 recall / retain / reflect / doctor / test
 * 依据: ~/ai-memory/PLAN.md
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = __dirname;
const CONFIG_PATH = path.join(SKILL_DIR, 'config.json');
const STATE_PATH = path.join(SKILL_DIR, 'state.json');

const LAYERS = ['fact', 'belief', 'exp', 'summary'];
const WEIGHTS = { fact: 1.0, summary: 0.9, exp: 0.7, belief: 0.6 };

const DEFAULTS = {
  base: 'http://localhost:41184',
  token: '',
  hostId: '', // 为空时自动使用 os.hostname()
  nb: '',
  layers: { fact: '', belief: '', exp: '', summary: '' },
  weights: WEIGHTS,
  budget: { maxNotes: 5, maxTokens: 800 },
  thresholds: { same_th: 0.75, rel_th: 0.30, N: 3, M: 20, decay_days: 60 },
  embed: {
    model: 'text-embedding-3-large',
    apiBase: 'https://api.chatanywhere.tech/v1',
    apiKey: '',
    dims: 3072,
  },
};

// ---------------- 存储层 ----------------
function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { titleVecs: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n'); }

// ---------------- 作用域与主机标识 ----------------
function resolveHostId(cfg) {
  return process.env.MEMORY_HOST_ID || cfg.hostId || os.hostname() || 'localhost';
}

/**
 * 解析笔记正文中的 scope 元数据
 * 格式支持: <!-- scope: host:xxx --> 或 <!-- scope: global --> 或 <!-- scope: xxx -->
 * 未标注时: fact 默认为当前环境 host，其余层级默认为 global
 */
function parseScope(body, layer = 'fact') {
  const m = (body || '').match(/<!--\s*scope:\s*([^\s>]+)\s*-->/i);
  if (m) {
    const raw = m[1].trim();
    return raw.toLowerCase() === 'global' ? 'global' : (raw.startsWith('host:') ? raw : `host:${raw}`);
  }
  return layer === 'fact' ? 'host' : 'global';
}

function normalizeScope(scope, currentHost) {
  if (!scope || scope === 'global') return 'global';
  if (scope === 'host' || scope === currentHost) return `host:${currentHost}`;
  return scope.startsWith('host:') ? scope : `host:${scope}`;
}

function setScope(body, scope) {
  const cleanBody = (body || '').replace(/<!--\s*scope:\s*([^\s>]+)\s*-->\n?/i, '').trim();
  const comment = `<!-- scope: ${scope} -->`;
  return cleanBody ? `${comment}\n${cleanBody}` : comment;
}

// 检查该 note 是否在当前机器可见 (global 或 host:<currentHost>)
function isScopeVisible(noteScope, currentHost) {
  if (noteScope === 'global') return true;
  return noteScope === `host:${currentHost}`;
}
function resolveToken(cfg) {
  if (process.env.JOPLIN_TOKEN) return process.env.JOPLIN_TOKEN;
  if (cfg.token) return cfg.token;
  for (const p of ['~/.config/joplin/settings.json', '~/.config/joplin-desktop/settings.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(p.replace(/^~/, os.homedir()), 'utf8'));
      if (s['api.token']) return s['api.token'];
    } catch { /* next */ }
  }
  return '';
}

// ---------------- Joplin REST ----------------
async function joplin(cfg, apiPath, opts = {}) {
  const sep = apiPath.includes('?') ? '&' : '?';
  const url = `${cfg.base}${apiPath}${sep}token=${encodeURIComponent(cfg.token)}`;
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`Joplin HTTP ${r.status}: ${typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const search = (cfg, q, fields) => joplin(cfg, `/search?query=${encodeURIComponent(q)}&fields=${fields}`);
const getNotes = (cfg, folderId, fields) => joplin(cfg, `/folders/${folderId}/notes?fields=${fields}`);
// 拉取四层全部记忆条目（记忆条目少，几十条内；用于去重/兜底，避免 FTS 英文词搜不到）
async function allLayerNotes(cfg) {
  const out = [];
  for (const l of LAYERS) {
    if (!cfg.layers[l]) continue;
    const notes = await getNotes(cfg, cfg.layers[l], 'id,title,body,parent_id,created_time,updated_time');
    out.push(...notes.items.map(n => ({ ...n, layer: l })));
  }
  return out;
}

// ---------------- 向量/相似度 ----------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cos(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}
// 降级: 字符 bigram Jaccard（离线、无 API）
function ngramSet(s, n = 2) {
  const set = new Set();
  const chars = [...String(s).replace(/\s+/g, '')];
  for (let i = 0; i <= chars.length - n; i++) set.add(chars.slice(i, i + n).join(''));
  return set;
}
function jaccard(a, b) {
  const A = ngramSet(a), B = ngramSet(b);
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

// embedding: 批量 + 重试(3) + 缓存(title->vec, state.json 持久化)
async function apiEmbed(cfg, texts) {
  const { apiBase, model } = cfg.embed;
  const key = process.env.EMBED_API_KEY || cfg.embed.apiKey;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${apiBase}/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.data.map(d => d.embedding);
    } catch (e) {
      lastErr = e;
      if (attempt === 2) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}
// texts: string[]; 命中缓存的不调 API; 失败抛错由上层降级
async function embed(cfg, texts) {
  const state = loadState();
  const cache = state.titleVecs;
  const need = [...new Set(texts.filter(t => !cache[t]))];
  if (need.length) {
    const vecs = await apiEmbed(cfg, need);
    need.forEach((t, i) => { cache[t] = vecs[i]; });
    saveState(state);
  }
  return { vec: t => cache[t], cache };
}

// ---------------- 判定 ----------------
function classify(sim, th) {
  if (sim >= th.same_th) return 'same';
  if (sim >= th.rel_th) return 'rel';
  return 'none';
}
const estTokens = s => Math.ceil(String(s).length * 0.75); // 中文为主，近似

// ---------------- 命令: doctor ----------------
async function cmdDoctor() {
  const cfg = loadConfig();
  const checks = [];
  try {
    const p = await fetch(`${cfg.base}/ping`);
    checks.push({ name: 'joplin-ping', ok: p.status === 200, detail: (await p.text()).slice(0, 40) });
  } catch (e) { checks.push({ name: 'joplin-ping', ok: false, detail: e.message }); }

  cfg.token = resolveToken(cfg);
  checks.push({ name: 'token', ok: !!cfg.token, detail: cfg.token ? 'resolved' : 'NOT FOUND' });

  const hostId = resolveHostId(cfg);
  checks.push({ name: 'host-id', ok: true, detail: hostId });

  if (cfg.token) {
    try {
      const folders = await joplin(cfg, '/folders?fields=id,title,parent_id');
      const root = folders.items.find(f => f.title === 'AI-Memory');
      if (root) {
        cfg.nb = root.id;
        for (const l of LAYERS) {
          const f = folders.items.find(x => x.parent_id === root.id && x.title === l);
          if (f) cfg.layers[l] = f.id;
        }
        checks.push({ name: 'layers', ok: LAYERS.every(l => cfg.layers[l]), detail: `nb=${cfg.nb} ${LAYERS.map(l => `${l}:${cfg.layers[l].slice(0, 6)}`).join(' ')}` });
      } else {
        checks.push({ name: 'layers', ok: false, detail: 'AI-Memory notebook not found' });
      }
      saveConfig(cfg);
    } catch (e) { checks.push({ name: 'layers', ok: false, detail: e.message }); }
  }

  // embedding 连通性（不强制）
  if (cfg.embed.apiKey || process.env.EMBED_API_KEY) {
    try {
      const v = await apiEmbed(cfg, ['连通性测试']);
      checks.push({ name: 'embedding', ok: v.length === 1 && v[0].length === cfg.embed.dims, detail: `dims=${v[0].length} model=${cfg.embed.model}` });
    } catch (e) { checks.push({ name: 'embedding', ok: false, detail: e.message }); }
  } else {
    checks.push({ name: 'embedding', ok: false, detail: 'apiKey missing (set config embed.apiKey or EMBED_API_KEY)' });
  }

  const ok = checks.every(c => c.ok);
  console.log(JSON.stringify({ ok, config: CONFIG_PATH, checks }, null, 2));
  return ok ? 0 : 1;
}

// ---------------- 命令: recall ----------------
async function cmdRecall(argv) {
  const cfg = loadConfig();
  const q = argv.join(' ');
  if (!q) throw new Error('usage: recall <关键词...>');
  const th = cfg.thresholds;
  const { maxNotes, maxTokens } = cfg.budget;
  const currentHost = resolveHostId(cfg);

  // 主路径：拉取四层全部条目
  const rawAll = await allLayerNotes(cfg);
  // 1. 作用域过滤：解析 scope 并仅保留 global 或当前 host 绑定的条目
  const all = rawAll.map(n => {
    const s = parseScope(n.body, n.layer);
    const resolvedScope = s === 'host' ? `host:${currentHost}` : s;
    return { ...n, scope: resolvedScope };
  }).filter(n => isScopeVisible(n.scope, currentHost));

  if (!all.length) {
    console.log(JSON.stringify({ results: [], meta: { query: q, hit: false, hostId: currentHost, note: '记忆库为空或无匹配当前主机的条目' } }, null, 2));
    return 0;
  }

  let gated;
  try {
    const { vec } = await embed(cfg, [q, ...all.map(n => n.title)]);
    const qv = vec(q);
    gated = all.map(n => ({ ...n, sim: cos(qv, vec(n.title)) }))
      .filter(n => n.sim >= th.rel_th)
      .sort((a, b) => b.sim - a.sim);
  } catch (e) {
    // 降级：标题含关键词优先
    const kw = q.split(/\s+/).filter(Boolean);
    gated = all.map(n => {
      const hit = kw.filter(k => n.title.includes(k)).length;
      return { ...n, sim: kw.length ? hit / kw.length : 0, degraded: true };
    }).filter(n => n.sim > 0).sort((a, b) => b.sim - a.sim);
  }

  // 层权重排序（同 sim 时）
  gated.sort((a, b) => (b.sim - a.sim) || (WEIGHTS[b.layer] - WEIGHTS[a.layer]));

  // 去重合并: 标题相似 >= same_th 的取一条（高权重层/高 sim 优先）
  const merged = [];
  for (const n of gated) {
    const sameAs = merged.find(m => titlesSimilar(n.title, m.title) && n.sim >= th.same_th && m.sim >= th.same_th);
    if (sameAs) continue;
    merged.push(n);
    if (merged.length >= maxNotes) break;
  }

  // 预算裁剪
  let tok = 0; const out = [];
  for (const n of merged) {
    const cleanBody = (n.body || '').replace(/<!--\s*scope:\s*[^\s>]+\s*-->\n?/i, '').trim();
    const t = estTokens(n.title) + estTokens(cleanBody);
    if (out.length && tok + t > maxTokens) break;
    out.push({
      id: n.id,
      layer: n.layer,
      scope: n.scope,
      title: n.title,
      body: cleanBody,
      sim: +n.sim.toFixed(3),
      relevance: n.sim >= th.same_th ? 'strong' : 'weak',
      degraded: !!n.degraded,
    });
    tok += t;
  }

  console.log(JSON.stringify({ results: out, meta: { query: q, hit: out.length > 0, hostId: currentHost, scanned: all.length, total: rawAll.length, budget: { maxNotes, maxTokens }, tokens: tok } }, null, 2));
  return 0;
}
function titlesSimilar(a, b) { // 粗等价: 去除标点后包含关系
  const na = a.replace(/[（）()·，。：:]/g, '');
  const nb = b.replace(/[（）()·，。：:]/g, '');
  return na.includes(nb) || nb.includes(na);
}
function layerName(cfg, pid) {
  for (const l of LAYERS) if (cfg.layers[l] === pid) return l;
  return 'other';
}

// ---------------- 命令: retain ----------------
// 解析正文中的置信度（格式：置信度：0.7 或 置信度:0.7）
function parseConfidence(body) {
  const m = (body || '').match(/置信度[：:]\s*([01](?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
// 设置/更新正文置信度，返回新 body
function setConfidence(body, conf) {
  const v = Math.max(0, Math.min(1, conf));
  const line = `置信度：${v.toFixed(1)}`;
  const rest = (body || '').replace(/\n?置信度[：:]\s*[01](?:\.\d+)?/, '').trim();
  return rest ? `${rest}\n${line}` : line;
}
async function cmdRetain(argv) {
  const cfg = loadConfig();
  const currentHost = resolveHostId(cfg);

  // 解析可选参数 --scope 与 --conf
  let scopeArg = null;
  const scopeIdx = argv.indexOf('--scope');
  if (scopeIdx !== -1 && argv[scopeIdx + 1]) {
    scopeArg = argv[scopeIdx + 1];
    argv.splice(scopeIdx, 2);
  }

  let explicitConf = null;
  const confIdx = argv.indexOf('--conf');
  if (confIdx !== -1 && argv[confIdx + 1]) {
    explicitConf = parseFloat(argv[confIdx + 1]);
    if (isNaN(explicitConf) || explicitConf < 0 || explicitConf > 1) {
      throw new Error(`非法置信度: "${argv[confIdx + 1]}"，需 0~1`);
    }
    argv.splice(confIdx, 2);
  }

  const layer = argv[0];
  const title = argv[1];
  const body = argv[2] || '';
  if (!LAYERS.includes(layer)) throw new Error(`非法 layer: "${layer}"，合法值: ${LAYERS.join('/')}`);
  if (!title) throw new Error('usage: retain <layer> <title> [body] [--scope <global|host>] [--conf <0~1>]');
  const th = cfg.thresholds;

  // 确定 targetScope
  // fact 默认绑定 host:<currentHost>，其余层级默认 global
  let targetScope;
  if (scopeArg) {
    targetScope = normalizeScope(scopeArg, currentHost);
  } else {
    targetScope = layer === 'fact' ? `host:${currentHost}` : 'global';
  }

  // belief 必须有置信度：显式 > 正文自带 > 默认 0.5
  let fullBody = body;
  if (layer === 'belief') {
    const cur = explicitConf !== null ? explicitConf : parseConfidence(body);
    fullBody = setConfidence(body, cur !== null ? cur : 0.5);
  }
  // 注入 scope 标签
  fullBody = setScope(fullBody, targetScope);

  // 候选：拉四层全部条目并解析 scope
  const rawCands = await allLayerNotes(cfg);
  const cands = rawCands.map(n => {
    const s = parseScope(n.body, n.layer);
    return { ...n, scope: s === 'host' ? `host:${currentHost}` : s };
  });

  // embedding 判定（标题级）
  let decisions = [];
  try {
    const { vec } = await embed(cfg, [title, ...cands.map(n => n.title)]);
    const tv = vec(title);
    decisions = cands.map(n => ({
      note: n,
      sim: cos(tv, vec(n.title)),
      cls: classify(cos(tv, vec(n.title)), th),
    }));
  } catch (e) {
    // 降级: 词面判定
    decisions = cands.map(n => {
      const s = jaccard(title, n.title);
      return { note: n, sim: s, cls: classify(s, th), degraded: true };
    });
  }

  // 去重覆盖判定：必须「同 scope」且「达到 same_th 阈值」才覆盖，避免异机配置互相踩踏
  const same = decisions.find(d => d.cls === 'same' && d.note.scope === targetScope);
  // 相关建议：同一 scope 或当前可见范围内的相关条目
  const rels = decisions.filter(d => d.cls === 'rel' && isScopeVisible(d.note.scope, currentHost));

  let result;
  if (same) {
    // 合并更新：取更完整正文；若 belief 再次确认（更新），置信度 +0.1 封顶 0.9
    let keep = (same.note.body || '').length >= fullBody.length ? same.note.body : fullBody;
    if (layer === 'belief') {
      const oldConf = parseConfidence(same.note.body);
      const newConf = explicitConf !== null ? explicitConf : (oldConf !== null ? oldConf + 0.1 : 0.5);
      keep = setConfidence(keep, Math.min(newConf, 0.9));
    }
    keep = setScope(keep, targetScope);
    await joplin(cfg, `/notes/${same.note.id}`, { method: 'PUT', body: JSON.stringify({ title, body: keep, parent_id: cfg.layers[layer] }) });
    result = { action: 'updated', id: same.note.id, layer, scope: targetScope, sameSim: +same.sim.toFixed(3), degraded: !!same.degraded };
    if (layer === 'belief') {
      const after = parseConfidence(keep);
      result.confidence = after;
      if (after >= 0.9) result.upgradeHint = `置信度已达 ${after}，建议 reflect 升级为 fact`;
    }
  } else {
    const created = await joplin(cfg, '/notes', { method: 'POST', body: JSON.stringify({ title, body: fullBody, parent_id: cfg.layers[layer] }) });
    result = { action: 'created', id: created.id, layer, scope: targetScope, relCount: rels.length, degraded: !!(rels[0] && rels[0].degraded) };
    if (layer === 'belief') result.confidence = parseConfidence(fullBody);
    if (rels.length >= th.N) {
      result.aggregateHint = `同实体互补条目已达 ${rels.length} 条（>=N=${th.N}），建议运行 reflect 聚合为 summary`;
    }
  }

  // 更新缓存（新/改标题的向量）
  try { await embed(cfg, [title]); } catch { /* cache best-effort */ }

  result.syncHint = '写入完成。运行 joplin sync（或等 cron ≤5min）后 search 才会索引';
  console.log(JSON.stringify({ result }, null, 2));
  return 0;
}

// ---------------- 命令: reflect ----------------
async function cmdReflect(argv) {
  const cfg = loadConfig();
  const applyIdx = argv.indexOf('--apply');
  if (applyIdx !== -1) {
    const spec = JSON.parse(argv[applyIdx + 1]);
    return applyReflect(cfg, spec);
  }
  // dry-run: 检测
  const th = cfg.thresholds;
  const currentHost = resolveHostId(cfg);
  const suggestions = [];
  const rawAll = await allLayerNotes(cfg);
  const all = rawAll.map(n => {
    const s = parseScope(n.body, n.layer);
    return { ...n, scope: s === 'host' ? `host:${currentHost}` : s };
  });

  // 1. 跨机共性经验泛化检测（若同类 exp/belief 分布在不同 host，建议泛化为 global）
  const crossHostGroups = [];
  const expNotes = all.filter(n => n.layer === 'exp' && n.scope.startsWith('host:'));
  // 同实体聚类（标题 embedding）
  const groups = [];
  const used = new Set();
  try {
    const { vec } = await embed(cfg, all.map(n => n.title));
    for (let i = 0; i < all.length; i++) {
      if (used.has(i)) continue;
      const g = [all[i]]; used.add(i);
      for (let j = i + 1; j < all.length; j++) {
        if (used.has(j)) continue;
        if (cos(vec(all[i].title), vec(all[j].title)) >= th.rel_th) { g.push(all[j]); used.add(j); }
      }
      if (g.length > 1) groups.push(g);
    }
  } catch (e) {
    console.log(JSON.stringify({ error: `embedding 不可用（${e.message}），reflect 需 embedding`, suggestions: [] }, null, 2));
    return 1;
  }
  for (const g of groups) {
    const layers = [...new Set(g.map(n => n.layer))];
    const scopes = [...new Set(g.map(n => n.scope))];
    const hasSummary = layers.includes('summary');
    const nonSummary = g.filter(n => n.layer !== 'summary');
    const hasFact = layers.includes('fact');
    const hasBelief = layers.includes('belief');

    // 跨主机相同经验检测
    if (scopes.length > 1 && layers.every(l => l === 'exp' || l === 'belief')) {
      suggestions.push({
        type: 'generalize-scope',
        reason: `检测到分布于多台设备 (${scopes.join(', ')}) 的同类经验，建议提炼并泛化为 scope: global`,
        sourceIds: g.map(n => n.id),
        targetLayer: g[0].layer,
        targetScope: 'global',
        materials: g.map(n => ({ id: n.id, layer: n.layer, scope: n.scope, title: n.title, body: n.body })),
      });
    }

    if (hasFact && hasBelief && !hasSummary) {
      suggestions.push({
        type: 'conflict-review', reason: '同实体 fact/belief 并存，需人工/LLM 判断冲突或互补',
        sourceIds: g.map(n => n.id), targetLayer: null,
        materials: g.map(n => ({ id: n.id, layer: n.layer, scope: n.scope, title: n.title, body: n.body })),
      });
    } else if (hasSummary && nonSummary.length >= 1) {
      suggestions.push({
        type: 'aggregate-to-summary', reason: `已有 summary + ${nonSummary.length} 条互补条目，建议把新 fact/exp 汇入 summary`, 
        sourceIds: g.map(n => n.id), targetLayer: 'summary',
        materials: g.map(n => ({ id: n.id, layer: n.layer, scope: n.scope, title: n.title, body: n.body })),
      });
    } else if (g.length >= th.N && !hasSummary) {
      suggestions.push({
        type: 'aggregate', reason: `同实体互补 ${g.length} 条（>=N=${th.N}），建议聚合为 summary`,
        sourceIds: g.map(n => n.id), targetLayer: 'summary',
        materials: g.map(n => ({ id: n.id, layer: n.layer, scope: n.scope, title: n.title, body: n.body })),
      });
    } else {
      suggestions.push({
        type: 'complement-keep', reason: `同实体互补 ${g.length} 条，未达 N=${th.N}，保持独立`,
        sourceIds: g.map(n => n.id), targetLayer: null,
        materials: g.map(n => ({ id: n.id, layer: n.layer, scope: n.scope, title: n.title })),
      });
    }
  }
  // belief 置信度升级 + 时间衰减
  const now = Date.now();
  for (const n of all.filter(x => x.layer === 'belief')) {
    const conf = parseConfidence(n.body);
    const upd = n.updated_time || 0;
    const ageDays = upd ? (now - upd) / 86400000 : 0;
    if (conf !== null && conf >= 0.9) {
      suggestions.push({ type: 'upgrade', reason: `belief 置信度 ${conf}>=0.9，建议升级 fact`, sourceIds: [n.id], targetLayer: 'fact', materials: [{ id: n.id, layer: 'belief', scope: n.scope, title: n.title, body: n.body }] });
    } else if (conf !== null && conf < 0.7 && ageDays >= th.decay_days) {
      suggestions.push({ type: 'decay-review', reason: `belief 置信度 ${conf}<0.7 且 ${Math.round(ageDays)} 天未更新，建议复核/降级/删除`, sourceIds: [n.id], targetLayer: null, materials: [{ id: n.id, layer: 'belief', scope: n.scope, title: n.title, body: n.body }] });
    }
  }
  console.log(JSON.stringify({ dryRun: true, suggestions }, null, 2));
  return 0;
}
async function applyReflect(cfg, spec) {
  const { action, targetLayer, targetScope, title, body, sourceIds } = spec;
  const currentHost = resolveHostId(cfg);
  let finalBody = body || '';
  if (targetScope) {
    finalBody = setScope(finalBody, normalizeScope(targetScope, currentHost));
  }
  if (action === 'aggregate') {
    if (!targetLayer || !LAYERS.includes(targetLayer)) throw new Error('aggregate 需要 targetLayer ∈ fact/belief/exp/summary');
    const created = await joplin(cfg, '/notes', { method: 'POST', body: JSON.stringify({ title, body: finalBody, parent_id: cfg.layers[targetLayer] }) });
    for (const id of sourceIds) await joplin(cfg, `/notes/${id}`, { method: 'DELETE' });
    console.log(JSON.stringify({ applied: 'aggregate', created: created.id, deleted: sourceIds }, null, 2));
  } else if (action === 'migrate') {
    const [id] = sourceIds;
    await joplin(cfg, `/notes/${id}`, { method: 'PUT', body: JSON.stringify({ title, body: finalBody, parent_id: cfg.layers[targetLayer] }) });
    console.log(JSON.stringify({ applied: 'migrate', id, targetLayer }, null, 2));
  } else {
    throw new Error(`未知 action: ${action}（支持 aggregate/migrate）`);
  }
  return 0;
}

// ---------------- 命令: test（隔离环境，Step 8）----------------
async function cmdTest() {
  const cfg = loadConfig();
  const results = [];
  const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); };
  // 1. embedding 维数 + 同句余弦 ≈1
  try {
    const { vec } = await embed(cfg, ['测试句子A', '测试句子A']);
    ok('embed-dims', vec('测试句子A').length === cfg.embed.dims, `dims=${vec('测试句子A').length}`);
    ok('embed-same-sim', Math.abs(cos(vec('测试句子A'), vec('测试句子A')) - 1) < 1e-6, 'cos≈1');
  } catch (e) { ok('embed', false, e.message); }
  // 2. 中文编码
  ok('url-encode', encodeURIComponent('服务器') === '%E6%9C%8D%E5%8A%A1%E5%99%A8');
  // 3. 非法 layer 拒绝
  try { await cmdRetain(['bogus', 't', 'b']); ok('retain-invalid-layer', false, '未拒绝'); }
  catch (e) { ok('retain-invalid-layer', /非法 layer/.test(e.message), e.message); }
  // 4. 判定函数
  ok('classify', classify(0.8, cfg.thresholds) === 'same' && classify(0.5, cfg.thresholds) === 'rel' && classify(0.1, cfg.thresholds) === 'none');
  // 5. Scope 解析与过滤逻辑测试
  const s1 = parseScope('<!-- scope: global -->\n正文', 'fact');
  const s2 = parseScope('<!-- scope: host:pc-1 -->\n正文', 'fact');
  const s3 = parseScope('无标签正文', 'fact');
  const s4 = parseScope('无标签正文', 'exp');
  ok('scope-parse', s1 === 'global' && s2 === 'host:pc-1' && s3 === 'host' && s4 === 'global', `s1=${s1}, s2=${s2}, s3=${s3}, s4=${s4}`);
  ok('scope-visibility', isScopeVisible('global', 'pc-1') === true && isScopeVisible('host:pc-1', 'pc-1') === true && isScopeVisible('host:pc-2', 'pc-1') === false);
  const taggedBody = setScope('原正文内容', 'host:test-node');
  ok('scope-set', taggedBody.includes('<!-- scope: host:test-node -->') && taggedBody.includes('原正文内容'));

  const allPass = results.every(r => r.pass);
  console.log(JSON.stringify({ test: 'memory', pass: allPass, results }, null, 2));
  return allPass ? 0 : 1;
}

// ---------------- 入口 ----------------
const USAGE = `memory — AI 长期记忆 CLI

用法:
  memory doctor                    诊断: 连通性/token/层id/embedding/host-id
  memory recall <关键词...>         门控召回记忆条目(按 scope 过滤) → JSON
  memory retain <layer> <title> [body] [--scope <global|host>] [--conf <0~1>]  写入(去重/更新) → JSON
  memory reflect                   检测冲突/聚合/升级/跨机泛化建议(dry-run) → JSON
  memory reflect --apply '<json>'  执行聚合/迁移
  memory test                      隔离环境测试例
  memory --help                    本帮助

layer: fact / belief / exp / summary
config: ${CONFIG_PATH}   state(向量缓存): ${STATE_PATH}`;

const cmd = process.argv[2];
try {
  let code;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); code = 0; }
  else if (cmd === 'doctor') code = await cmdDoctor();
  else if (cmd === 'recall') code = await cmdRecall(process.argv.slice(3));
  else if (cmd === 'retain') code = await cmdRetain(process.argv.slice(3));
  else if (cmd === 'reflect') code = await cmdReflect(process.argv.slice(3));
  else if (cmd === 'test') code = await cmdTest();
  else { console.error(`未知命令: ${cmd}\n${USAGE}`); code = 1; }
  process.exit(code);
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
