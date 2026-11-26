(() => {
  const S = window.__S = { v: 'v2', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    status: 'starting', err: null, importError: null, ver: {}, msgs: [], add: [],
    hasPendingApi: false, repoReady: false, ready: null };
  const done = (m) => { S.status = m; return m; };

  const BI = window.ButlerIntent;
  if (!BI) return done('FAIL: window.ButlerIntent 不存在');
  const miss = ['gate', 'handleAIResponse', 'reminderTitleFrom'].filter((k) => typeof BI[k] !== 'function');
  if (miss.length) return done('FAIL: ButlerIntent 缺 ' + miss.join(','));

  S.ver.hasFix = /过后/.test(Function.prototype.toString.call(BI.reminderTitleFrom));
  S.hasPendingApi = typeof BI.hasPending === 'function';

  const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const safe = (fn) => { try { return fn(); } catch (e) { return 'ERR:' + ((e && e.message) || e); } };
  let repo = null;
  const count = async () => {
    if (!repo) return 'no-repo';
    try { return (await repo.listTasks()).length; } catch (e) { return 'ERR:' + ((e && e.message) || e); }
  };

  const oGate = BI.gate, oHandle = BI.handleAIResponse;
  BI.gate = function (t) {
    let g;
    try { g = oGate.call(BI, t); }
    catch (e) { S.msgs.push({ at: now(), step: 'gate', text: String(t || ''), err: String((e && e.message) || e) }); throw e; }
    S.msgs.push({ at: now(), step: 'gate', text: String(t || ''), gate: g });
    return g;
  };
  BI.handleAIResponse = async function (raw, text, baseMs) {
    const r = { at: now(), step: 'handle', text: String(text || ''), baseMs, baseType: typeof baseMs,
      hasMarker: /<bl>/.test(String(raw || '')), rawHead: String(raw || '').slice(0, 400),
      rel: safe(() => BI.relativeTarget(text, baseMs)),
      abs: safe(() => BI.absoluteTarget(text, baseMs)),
      title: safe(() => BI.reminderTitleFrom(text)),
      pendingBefore: S.hasPendingApi ? safe(() => BI.hasPending()) : 'n/a',
      countBefore: await count() };
    let full;
    try { full = await oHandle.call(BI, raw, text, baseMs); }
    catch (e) { r.err = String((e && e.stack) || e); S.msgs.push(r); throw e; }
    r.outPreview = String(full).slice(0, 200);
    r.countAfter = await count();
    r.pendingAfter = S.hasPendingApi ? safe(() => BI.hasPending()) : 'n/a';
    S.msgs.push(r);
    return full;
  };

  S.ready = (async () => {
    try {
      const m = await import('/butler/butler-repository.js');
      repo = m && m.repository;
      if (!repo || typeof repo.addTask !== 'function' || typeof repo.listTasks !== 'function') {
        S.importError = 'repository 缺 addTask/listTasks';
        return S.status = 'PARTIAL: gate/handle 已生效，addTask 未接入';
      }
      const oAdd = repo.addTask;
      S.origAdd = oAdd;
      repo.addTask = async function (input) {
        let cloned;
        try { cloned = JSON.parse(JSON.stringify(input || {})); } catch (e) { cloned = String(input); }
        const rec = { at: now(), input: cloned };
        let out;
        try { out = await oAdd.call(repo, input); }
        catch (e) { rec.ok = false; rec.err = String((e && e.stack) || e); S.add.push(rec); throw e; }
        rec.ok = true; rec.id = out && out.id; rec.title = out && out.title;
        rec.date = out && out.date; rec.time = out && out.time;
        rec.countAfter = await count();
        S.add.push(rec);
        return out;
      };
      S.repoReady = true;
      return S.status = 'OK: repo 已接入, tasks=' + (await count());
    } catch (e) {
      S.importError = String((e && e.stack) || e);
      return S.status = 'PARTIAL: import 失败 ' + ((e && e.message) || e);
    }
  })();

  S.dump = () => {
    console.log('status:', S.status, '| hasFix:', S.ver.hasFix, '| hasPending:', S.hasPendingApi, '| importError:', S.importError);
    console.table(S.msgs.map((m) => ({ at: m.at, step: m.step, gate: m.gate, marker: m.hasMarker,
      title: m.title, rel: JSON.stringify(m.rel), abs: JSON.stringify(m.abs),
      baseMs: m.baseMs, before: m.countBefore, after: m.countAfter,
      pend: m.pendingBefore, pend2: m.pendingAfter, err: m.err })));
    console.table(S.add.map((a) => ({ at: a.at, ok: a.ok, title: a.input && a.input.title,
      date: a.input && a.input.date, time: a.input && a.input.time, id: a.id, after: a.countAfter, err: a.err })));
    S.msgs.filter((m) => m.step === 'handle').forEach((m, i) => {
      console.log('#' + (i + 1) + ' out:', m.outPreview);
      console.log('#' + (i + 1) + ' raw:', m.rawHead);
    });
    return 'ok';
  };
  S.restore = () => {
    BI.gate = oGate; BI.handleAIResponse = oHandle;
    if (repo && S.origAdd) repo.addTask = S.origAdd;
    delete window.__S;
    return 'restored';
  };

  return done('hooked（等 __S.ready 完成）');
})();
