// Server-side flow-metrics for the PLT Resource Planner.
// Computes cycle time / throughput / flow efficiency / aging from Jira status history,
// ONCE, and lets Vercel's CDN cache the result so every exec who opens the app shares
// the same computation instead of each browser re-running the heavy changelog pull.
//
// Caching: s-maxage=21600 (6h) means the edge serves a cached copy for 6 hours;
// stale-while-revalidate keeps responses instant while it refreshes in the background.
// Net effect: the expensive Jira query runs ~once per 6h total, not per visit.
//
// Env vars required (set in Vercel Project Settings): JIRA_EMAIL, JIRA_TOKEN.
// Optional: JIRA_SITE (default centerfieldmedia), JIRA_PROJECTS (default PLT),
//           JIRA_WORKING_STATES (default "in dev,code review"), JIRA_CYCLE_START (default "in dev").

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');

  const EMAIL = process.env.JIRA_EMAIL, TOKEN = process.env.JIRA_TOKEN;
  const SITE = (process.env.JIRA_SITE || 'https://centerfieldmedia.atlassian.net').replace(/\/$/, '');
  const PROJECTS = (process.env.JIRA_PROJECTS || 'PLT');
  const WORK = (process.env.JIRA_WORKING_STATES || 'in dev,code review').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const CYCLE_START = (process.env.JIRA_CYCLE_START || 'in dev').toLowerCase();

  if (!EMAIL || !TOKEN) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ error: 'Set JIRA_EMAIL and JIRA_TOKEN environment variables in Vercel.', asOf: null });
    return;
  }

  const auth = 'Basic ' + Buffer.from(EMAIL + ':' + TOKEN).toString('base64');
  const headers = { Authorization: auth, Accept: 'application/json' };
  const DAY = 86400000, now = Date.now();

  function tkCat(st) {
    st = (st || '').toLowerCase().trim();
    if (st === 'done' || st === 'ready for release' || st === 'closed' || st === 'resolved' || st === 'released' || st === 'complete' || st === 'completed') return 'done';
    if (st.indexOf('qa') >= 0 || st.indexOf('testing') >= 0) return 'qa';
    if (st.indexOf('block') >= 0 || st.indexOf('hold') >= 0 || st.indexOf('impediment') >= 0) return 'blocked';
    if (st === 'to do' || st.indexOf('ready for dev') >= 0 || st === 'backlog' || st === 'open' || st === 'new' || st.indexOf('selected for dev') >= 0 || st === 'ready' || st === 'reopened' || st === 'ready for development') return 'todo';
    return 'active';
  }
  const isWork = st => WORK.indexOf((st || '').toLowerCase().trim()) >= 0;
  const isBlk = st => { const s = (st || '').toLowerCase(); return s.indexOf('block') >= 0 || s.indexOf('hold') >= 0; };
  const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

  try {
    let SP = process.env.JIRA_SP_FIELD || '';
    if (!SP) { try { const fr = await fetch(SITE + '/rest/api/3/field', { headers }); if (fr.ok) { const fields = await fr.json(); const m = (fields.find(f => /story point estimate/i.test(f.name)) || fields.find(f => /story points?/i.test(f.name))); if (m) SP = m.id; } } catch (e) {} }
    const jql = 'project in (' + PROJECTS + ') AND (resolutiondate >= -60d OR statusCategory != Done)';
    let issues = [], nextPageToken = null;
    for (let i = 0; i < 25; i++) {
      const url = SITE + '/rest/api/3/search/jql?jql=' + encodeURIComponent(jql) + '&fields=status,created,resolutiondate,assignee,issuetype,updated,summary' + (SP ? ',' + SP : '') + '&expand=changelog&maxResults=100' + (nextPageToken ? '&nextPageToken=' + encodeURIComponent(nextPageToken) : '');
      const r = await fetch(url, { headers });
      if (!r.ok) { if (!nextPageToken) { res.setHeader('Cache-Control', 'no-store'); res.status(502).json({ error: 'Jira responded ' + r.status, asOf: null }); return; } break; }
      const data = await r.json();
      const batch = data.issues || [];
      issues = issues.concat(batch);
      if (data.isLast || !data.nextPageToken || !batch.length) break;
      nextPageToken = data.nextPageToken;
    }

    const cycles = [], aging = [], doneTimes = [];
    const dvCyc = {}, dvDone = {}, dvAge = {}, dvActMs = {}, dvCycMs = {}, dvDonePts = {}, dvBugs = {}, dvSubDone = {}, person = {};
    const teamDonePts = []; const storySubAssignees = {}, doneStories = [], cycleDated = [], shippedTimes = [], doneList = [];
    const SHIP_TYPE = (process.env.JIRA_SHIP_TYPE || 'system change').toLowerCase();
    let totActive = 0, totCycle = 0; const blockedDurs = []; let blockedCount = 0, analyzedCount = 0;

    issues.forEach(is => {
      const f = is.fields || {};
      const a = f.assignee;
      const pid = a ? (a.accountId || a.displayName) : null;
      if (a && pid && !person[pid]) person[pid] = { displayName: a.displayName || '', email: (a.emailAddress || '') };
      const trans = [];
      ((is.changelog && is.changelog.histories) || []).forEach(h => { const at = Date.parse(h.created); (h.items || []).forEach(it => { if (it.field === 'status') trans.push({ at: at, to: (it.toString || ''), from: (it.fromString || '') }); }); });
      trans.sort((x, y) => x.at - y.at);
      let startT = null; for (const t of trans) { if ((t.to || '').toLowerCase() === CYCLE_START) { startT = t.at; break; } }
      if (startT == null) { for (const t of trans) { if (tkCat(t.to) === 'active') { startT = t.at; break; } } }
      let doneT = null; for (const t of trans) { if (tkCat(t.to) === 'done') { doneT = t.at; break; } }
      if (doneT == null && f.resolutiondate) doneT = Date.parse(f.resolutiondate);
      const curCat = tkCat((f.status && f.status.name) || '');
      const created = Date.parse(f.created) || (trans.length ? trans[0].at : now);
      const isSub = !!(f.issuetype && f.issuetype.subtask);
      const parentKey = (f.parent && f.parent.key) || null;
      if (isSub && parentKey && pid) (storySubAssignees[parentKey] = storySubAssignees[parentKey] || {})[pid] = 1;
      if (pid && f.issuetype && /bug|defect/i.test(f.issuetype.name || '')) (dvBugs[pid] = dvBugs[pid] || []).push(created);
      const tl = [{ st: (trans.length ? trans[0].from : ((f.status && f.status.name) || '')), at: created }];
      trans.forEach(t => tl.push({ st: t.to, at: t.at }));
      const endLife = (curCat === 'done' && doneT) ? doneT : now;
      let blk = 0; for (let i = 0; i < tl.length; i++) { const s = tl[i].at, e = (i + 1 < tl.length ? tl[i + 1].at : endLife); if (e > s && isBlk(tl[i].st)) blk += (e - s); }
      if (startT != null) { analyzedCount++; if (blk > 0) { blockedCount++; blockedDurs.push(blk / DAY); } }
      if (curCat === 'done' && doneT) {
        doneTimes.push(doneT);
        const pts = (SP && typeof f[SP] === 'number' && !isNaN(f[SP])) ? f[SP] : 0;
        teamDonePts.push({ t: doneT, p: pts });
        if (f.issuetype && (f.issuetype.name || '').toLowerCase() === SHIP_TYPE) shippedTimes.push(doneT);
        if (pid) (dvDonePts[pid] = dvDonePts[pid] || []).push({ t: doneT, p: pts });
        if (isSub) { if (pid) (dvSubDone[pid] = dvSubDone[pid] || []).push(doneT); }
        else { doneStories.push({ key: is.key, pts: pts, doneT: doneT, assignee: pid }); }
        const cy = (startT && doneT > startT) ? (doneT - startT) / DAY : null;
        if (cy != null) cycles.push(cy);
        doneList.push({ k: is.key, s: (f.summary || '').slice(0, 80), a: (f.assignee && f.assignee.displayName) || '', p: (SP && typeof f[SP] === 'number') ? f[SP] : null, t: doneT, cy: cy != null ? Math.round(cy * 10) / 10 : null });
        if (cy != null) cycleDated.push({ t: doneT, v: cy });
        if (pid) { (dvDone[pid] = dvDone[pid] || []).push(doneT); if (cy != null) (dvCyc[pid] = dvCyc[pid] || []).push(cy); }
        if (startT && doneT > startT) {
          let act = 0; for (let i = 0; i < tl.length; i++) { const ss = tl[i].at, ee = (i + 1 < tl.length ? tl[i + 1].at : doneT); const s = Math.max(ss, startT), e = Math.min(ee, doneT); if (e > s && isWork(tl[i].st)) act += (e - s); }
          totActive += act; totCycle += (doneT - startT);
          if (pid) { dvActMs[pid] = (dvActMs[pid] || 0) + act; dvCycMs[pid] = (dvCycMs[pid] || 0) + (doneT - startT); }
        }
      } else if (!isSub && startT && (curCat === 'active' || curCat === 'qa' || curCat === 'blocked') && f.updated && Date.parse(f.updated) >= now - 30 * DAY) {
        const ag = (now - startT) / DAY; aging.push(ag); if (pid) (dvAge[pid] = dvAge[pid] || []).push(ag);
      }
    });

    const wkMs = 7 * DAY; const nowD = new Date(); nowD.setHours(0, 0, 0, 0);
    const dow = (nowD.getDay() + 6) % 7; const curMon = nowD.getTime() - dow * DAY;
    const NW = 8; const thru = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; thru.push(doneTimes.filter(t => t >= s && t < e).length); }
    const thruAvg = thru.length ? Math.round(thru.reduce((a, b) => a + b, 0) / thru.length * 10) / 10 : 0;
    const ptsWeek = arr => { const w8 = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; w8.push(arr.filter(x => x.t >= s && x.t < e).reduce((a, b) => a + (b.p || 0), 0)); } return w8; };
    const teamPtsWk = ptsWeek(teamDonePts);
    const teamStoriesWk = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; teamStoriesWk.push(doneStories.filter(x => x.doneT >= s && x.doneT < e).length); }
    const teamStoryAvg = teamStoriesWk.length ? Math.round(teamStoriesWk.reduce((a, b) => a + b, 0) / teamStoriesWk.length * 10) / 10 : 0;
    const shippedWk = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; shippedWk.push(shippedTimes.filter(t => t >= s && t < e).length); }
    const winStart = curMon - NW * wkMs; const doneListW = doneList.filter(function (x) { return x.t >= winStart; });
    const shippedAvg = shippedWk.length ? Math.round(shippedWk.reduce((a, b) => a + b, 0) / shippedWk.length * 10) / 10 : 0;
    const cycleWk = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; const vals = cycleDated.filter(x => x.t >= s && x.t < e).map(x => x.v); cycleWk.push(vals.length ? Math.round(pct(vals, 50) * 10) / 10 : 0); }
    const teamVelocity = teamPtsWk.length ? Math.round(teamPtsWk.reduce((a, b) => a + b, 0) / teamPtsWk.length * 10) / 10 : 0;
    const dvSplitPts = {};
    doneStories.forEach(st => {
      const owners = storySubAssignees[st.key] ? Object.keys(storySubAssignees[st.key]) : (st.assignee ? [st.assignee] : []);
      if (!owners.length || !(st.pts > 0)) return;
      const share = st.pts / owners.length;
      owners.forEach(pid => { (dvSplitPts[pid] = dvSplitPts[pid] || []).push({ t: st.doneT, p: share }); });
    });

    const byPerson = {};
    Object.keys(dvSubDone).concat(Object.keys(dvAge)).concat(Object.keys(dvSplitPts)).concat(Object.keys(dvCyc)).filter((v, i, a) => a.indexOf(v) === i).forEach(pid => {
      const dts = dvSubDone[pid] || []; const dthru = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; dthru.push(dts.filter(t => t >= s && t < e).length); }
      const dta = dthru.length ? Math.round(dthru.reduce((a, b) => a + b, 0) / dthru.length * 10) / 10 : 0;
      const pwk = ptsWeek(dvSplitPts[pid] || []);
      const vel = pwk.length ? Math.round(pwk.reduce((a, b) => a + b, 0) / pwk.length * 10) / 10 : 0;
      const bwk = []; for (let w = NW - 1; w >= 0; w--) { const s = curMon - w * wkMs, e = s + wkMs; bwk.push((dvBugs[pid] || []).filter(t => t >= s && t < e).length); }
      const bugsWk = bwk.length ? Math.round(bwk.reduce((a, b) => a + b, 0) / bwk.length * 10) / 10 : 0;
      byPerson[pid] = {
        displayName: (person[pid] && person[pid].displayName) || '', email: (person[pid] && person[pid].email) || '',
        cycleP50: pct(dvCyc[pid] || [], 50), cycleP85: pct(dvCyc[pid] || [], 85), cycleN: (dvCyc[pid] || []).length,
        doneN: dts.length, thru: dthru, thruAvg: dta, ptsWk: pwk, velocity: vel, bugsN: (dvBugs[pid] || []).length, bugsWk: bugsWk, agingP85: pct(dvAge[pid] || [], 85), wipN: (dvAge[pid] || []).length,
        flowEff: (dvCycMs[pid] > 0 ? Math.round(dvActMs[pid] / dvCycMs[pid] * 100) : null)
      };
    });

    const flowEff = totCycle > 0 ? Math.round(totActive / totCycle * 100) : null;
    const _mean = thru.length ? thru.reduce((a, b) => a + b, 0) / thru.length : 0;
    const _var = thru.length ? thru.reduce((a, b) => a + (b - _mean) * (b - _mean), 0) / thru.length : 0;
    const cv = _mean > 0 ? Math.sqrt(_var) / _mean : null;
    const predict = cv == null ? '—' : (cv < 0.5 ? 'Stable' : cv < 0.9 ? 'Variable' : 'Erratic');
    const blockerRate = analyzedCount ? Math.round(blockedCount / analyzedCount * 100) : 0;
    const medBlocked = blockedDurs.length ? (function () { const s = [...blockedDurs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; })() : null;

    res.status(200).json({
      cycleP50: pct(cycles, 50), cycleP85: pct(cycles, 85), cycleP95: pct(cycles, 95), cycleN: cycles.length,
      thru: thru, thruAvg: thruAvg, teamPtsWk: teamPtsWk, teamVelocity: teamVelocity, teamStoriesWk: teamStoriesWk, teamStoryAvg: teamStoryAvg, shippedWk: shippedWk, shippedAvg: shippedAvg, doneList: doneListW, cycleWk: cycleWk, agingP85: pct(aging, 85), wipN: aging.length,
      startState: CYCLE_START, flowEff: flowEff, predict: predict, cv: cv == null ? null : Math.round(cv * 100) / 100,
      blockerRate: blockerRate, medBlocked: medBlocked, blockedN: blockedCount,
      byPerson: byPerson, asOf: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ error: String(e), asOf: null });
  }
};
