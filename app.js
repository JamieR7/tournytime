const state = {
  title: "PE TOURNAMENT",
  numTeams: 8, // Supports 4 to 12 teams
  format: "groups", // 'groups' | 'roundrobin'
  timingMode: "finish", // 'finish' | 'manual'
  startTimeMode: "now", // 'now' | 'custom'
  customStartTime: "10:00",
  desiredFinishTime: "11:00",
  manualMinutes: 4,
  manualSeconds: 0,
  intermissionSeconds: 10,
  numCourts: 2, // Supports 1 to 4 courts
  teamNames: [
    "Team 1", "Team 2", "Team 3", "Team 4",
    "Team 5", "Team 6", "Team 7", "Team 8",
    "Team 9", "Team 10", "Team 11", "Team 12"
  ],
  courtNames: ["Court 1", "Court 2", "Court 3", "Court 4"],

  inProgress: false,
  rounds: [],
  currentRoundIndex: 0,
  gameDurationSec: 240,
  timeLeftSec: 240,
  timerRunning: false,
  inIntermission: false,
  intermissionLeftSec: 10,
  autoAdvance: true,
  timerInterval: null,
  darkMode: true
};

const FUN_PE_NAMES = [
  "Versoix Vipers", "Léman Panthers", "Geneva Giants", "Alpine Eagles",
  "Divonne Dynamos", "Jura Jaguars", "Mont Blanc Bears", "Rhône Raiders",
  "Lausanne Lions", "Nyon Ninjas", "Valais Vikings", "Bern Broncos"
];

let audioCtx = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

function playCountdownPip(freq = 880, duration = 0.12) {
  try {
    ensureAudioContext();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {}
}

function playArenaBuzzer() {
  try {
    ensureAudioContext();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const freqs = [145, 217.5, 290, 435];
    freqs.forEach((f) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.linearRampToValueAtTime(f * 0.96, now + 1.45);
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.16, now + 0.05);
      gain.gain.setValueAtTime(0.16, now + 1.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 1.55);
    });
  } catch (e) {}
}

function playStartWhistle() {
  try {
    ensureAudioContext();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(2600, now);
    osc.frequency.setValueAtTime(2850, now + 0.08);
    osc.frequency.setValueAtTime(2600, now + 0.16);
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  } catch (e) {}
}

// Ensures every active team has a unique string name so standings & court packing never collide
function getSanitizedActiveTeams() {
  const seen = new Map();
  return state.teamNames.slice(0, state.numTeams).map((raw, idx) => {
    let base = (raw || "").trim() || `Team ${idx + 1}`;
    if (!seen.has(base)) {
      seen.set(base, 1);
      return base;
    } else {
      const count = seen.get(base) + 1;
      seen.set(base, count);
      const uniqueName = `${base} (${count})`;
      seen.set(uniqueName, 1);
      return uniqueName;
    }
  });
}

// Returns an array of circle-method rounds, where each sub-array is a conflict-free set of pairings
function generateRoundRobinSubRounds(teams) {
  const list = [...teams];
  if (list.length % 2 !== 0) list.push(null); // Bye for odd team counts
  const n = list.length;
  const numRounds = n - 1;
  const half = n / 2;
  const subRounds = [];

  for (let r = 0; r < numRounds; r++) {
    const roundPairings = [];
    for (let i = 0; i < half; i++) {
      const t1 = list[i];
      const t2 = list[n - 1 - i];
      if (t1 !== null && t2 !== null) roundPairings.push({ teamA: t1, teamB: t2 });
    }
    subRounds.push(roundPairings);
    const last = list.pop();
    list.splice(1, 0, last);
  }
  return subRounds;
}

function packMatchesIntoRounds(matchPool, numCourts) {
  const remaining = [...matchPool];
  const rounds = [];

  while (remaining.length > 0) {
    const roundMatches = [];
    const usedTeams = new Set();

    for (let i = 0; i < remaining.length; i++) {
      if (roundMatches.length >= numCourts) break;
      const m = remaining[i];
      if (!usedTeams.has(m.teamA) && !usedTeams.has(m.teamB)) {
        roundMatches.push(m);
        usedTeams.add(m.teamA);
        usedTeams.add(m.teamB);
        remaining.splice(i, 1);
        i--;
      }
    }
    if (roundMatches.length === 0 && remaining.length > 0) {
      roundMatches.push(remaining.shift());
    }
    rounds.push(roundMatches);
  }
  return rounds;
}

function buildTournamentSchedule() {
  const activeTeams = getSanitizedActiveTeams();
  const numCourts = state.numCourts;
  let allRounds = [];
  let matchIdCounter = 1;

  if (state.format === "roundrobin") {
    const subRounds = generateRoundRobinSubRounds(activeTeams);
    const rawPairings = subRounds.flat().map((p) => ({
      id: matchIdCounter++,
      stage: "LEAGUE",
      groupLabel: "League",
      teamA: p.teamA,
      teamB: p.teamB,
      scoreA: 0,
      scoreB: 0,
      completed: false,
      edited: false
    }));
    allRounds = packMatchesIntoRounds(rawPairings, numCourts);
  } else {
    // 2 Groups split (supports 4 to 12 teams, including odd numbers like 5, 7, 9, 11)
    const half = Math.ceil(activeTeams.length / 2);
    const groupA = activeTeams.slice(0, half);
    const groupB = activeTeams.slice(half);

    // Keep circle-method sub-rounds intact so parallelizable games within each group stay together
    const subRoundsA = generateRoundRobinSubRounds(groupA).map((rnd) =>
      rnd.map((p) => ({
        id: matchIdCounter++,
        stage: "GROUP STAGE",
        groupLabel: "Group A",
        teamA: p.teamA,
        teamB: p.teamB,
        scoreA: 0,
        scoreB: 0,
        completed: false,
        edited: false
      }))
    );

    const subRoundsB = generateRoundRobinSubRounds(groupB).map((rnd) =>
      rnd.map((p) => ({
        id: matchIdCounter++,
        stage: "GROUP STAGE",
        groupLabel: "Group B",
        teamA: p.teamA,
        teamB: p.teamB,
        scoreA: 0,
        scoreB: 0,
        completed: false,
        edited: false
      }))
    );

    // Interleave sub-round by sub-round (preserving parallel pairs within Group A & Group B)
    const orderedPool = [];
    const maxSubRounds = Math.max(subRoundsA.length, subRoundsB.length);
    for (let r = 0; r < maxSubRounds; r++) {
      const rA = subRoundsA[r] || [];
      const rB = subRoundsB[r] || [];
      // Put the group with more matches in this sub-round first to maximize court packing
      if (rA.length >= rB.length) {
        orderedPool.push(...rA, ...rB);
      } else {
        orderedPool.push(...rB, ...rA);
      }
    }

    const groupRounds = packMatchesIntoRounds(orderedPool, numCourts);

    // Build Placement Finals based on how many pairs exist across Group A & Group B
    const maxCommonRank = Math.min(groupA.length, groupB.length);
    const placementLabels = {
      6: "11th Place Playoff",
      5: "9th Place Playoff",
      4: "7th Place Playoff",
      3: "5th Place Playoff",
      2: "Bronze Final (3rd/4th)",
      1: "🏆 GRAND FINAL (1st/2nd)"
    };
    const ordinal = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

    const finalsMatches = [];
    for (let r = maxCommonRank; r >= 1; r--) {
      const defaultA = `${ordinal(r)} Group A`;
      const defaultB = `${ordinal(r)} Group B`;
      finalsMatches.push({
        id: matchIdCounter++,
        stage: "FINALS",
        groupLabel: placementLabels[r] || `Rank ${r} Playoff`,
        placeholderA: { group: "A", rank: r, defaultLabel: defaultA },
        placeholderB: { group: "B", rank: r, defaultLabel: defaultB },
        teamA: defaultA,
        teamB: defaultB,
        scoreA: 0,
        scoreB: 0,
        completed: false,
        edited: false,
        isFinal: true
      });
    }

    const finalsRounds = [];
    for (let i = 0; i < finalsMatches.length; i += numCourts) {
      finalsRounds.push(finalsMatches.slice(i, i + numCourts));
    }
    allRounds = [...groupRounds, ...finalsRounds];
  }

  allRounds.forEach((rnd, rIdx) => {
    rnd.forEach((m, cIdx) => {
      m.roundNumber = rIdx + 1;
      m.courtIndex = cIdx;
    });
  });

  return allRounds;
}

function computeGroupStandings(teamList, groupFilterLabel = null) {
  const stats = {};
  teamList.forEach((t) => {
    stats[t] = { team: t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 };
  });

  state.rounds.forEach((rnd, rIdx) => {
    rnd.forEach((m) => {
      if (m.isFinal) return;
      if (groupFilterLabel && m.groupLabel !== groupFilterLabel) return;
      const isPlayed =
        m.completed ||
        m.edited ||
        rIdx < state.currentRoundIndex ||
        m.scoreA > 0 ||
        m.scoreB > 0;
      if (!isPlayed) return;

      const stA = stats[m.teamA];
      const stB = stats[m.teamB];
      if (!stA || !stB) return;

      stA.P += 1;
      stB.P += 1;
      stA.GF += m.scoreA;
      stA.GA += m.scoreB;
      stB.GF += m.scoreB;
      stB.GA += m.scoreA;
      stA.GD = stA.GF - stA.GA;
      stB.GD = stB.GF - stB.GA;

      if (m.scoreA > m.scoreB) {
        stA.W += 1;
        stA.Pts += 3;
        stB.L += 1;
      } else if (m.scoreB > m.scoreA) {
        stB.W += 1;
        stB.Pts += 3;
        stA.L += 1;
      } else {
        stA.D += 1;
        stB.D += 1;
        stA.Pts += 1;
        stB.Pts += 1;
      }
    });
  });

  return Object.values(stats).sort((a, b) => {
    if (b.Pts !== a.Pts) return b.Pts - a.Pts;
    if (b.GD !== a.GD) return b.GD - a.GD;
    if (b.GF !== a.GF) return b.GF - a.GF;
    return a.team.localeCompare(b.team);
  });
}

function updateFinalsSeedingIfReady() {
  if (state.format !== "groups") return;
  const activeTeams = getSanitizedActiveTeams();
  const half = Math.ceil(activeTeams.length / 2);
  const groupATeams = activeTeams.slice(0, half);
  const groupBTeams = activeTeams.slice(half);

  const standingsA = computeGroupStandings(groupATeams, "Group A");
  const standingsB = computeGroupStandings(groupBTeams, "Group B");

  const anyGroupAPlayed = standingsA.some((s) => s.P > 0);
  const anyGroupBPlayed = standingsB.some((s) => s.P > 0);

  state.rounds.forEach((rnd) => {
    rnd.forEach((m) => {
      if (m.isFinal && m.placeholderA && m.placeholderB) {
        const rankA = m.placeholderA.rank - 1;
        const rankB = m.placeholderB.rank - 1;
        m.teamA =
          anyGroupAPlayed && standingsA[rankA]
            ? standingsA[rankA].team
            : m.placeholderA.defaultLabel;
        m.teamB =
          anyGroupBPlayed && standingsB[rankB]
            ? standingsB[rankB].team
            : m.placeholderB.defaultLabel;
      }
    });
  });
}

function calculateGameDurationSeconds(numRounds) {
  if (numRounds <= 0) return 240;

  if (state.timingMode === "manual") {
    const parsedMin = parseInt(state.manualMinutes, 10);
    const parsedSec = parseInt(state.manualSeconds, 10);
    const mins = isNaN(parsedMin) ? 4 : Math.max(0, parsedMin);
    const secs = isNaN(parsedSec) ? 0 : Math.max(0, parsedSec);
    return Math.max(15, mins * 60 + secs);
  }

  const now = new Date();
  let startTotalSeconds =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  if (state.startTimeMode === "custom" && state.customStartTime) {
    const [sh, sm] = state.customStartTime.split(":").map(Number);
    if (!isNaN(sh) && !isNaN(sm)) startTotalSeconds = (sh * 60 + sm) * 60;
  }

  let finishTotalSeconds = startTotalSeconds + 45 * 60;
  if (state.desiredFinishTime) {
    const [fh, fm] = state.desiredFinishTime.split(":").map(Number);
    if (!isNaN(fh) && !isNaN(fm)) finishTotalSeconds = (fh * 60 + fm) * 60;
  }

  let diffSeconds = finishTotalSeconds - startTotalSeconds;
  if (diffSeconds <= 0) diffSeconds += 24 * 3600;

  const totalIntermission = Math.max(0, numRounds - 1) * state.intermissionSeconds;
  const availablePlaySeconds = Math.max(numRounds * 25, diffSeconds - totalIntermission);
  return Math.floor(availablePlaySeconds / numRounds);
}

function formatMMSS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getExpectedFinishTimeString() {
  const remainingFutureRounds = Math.max(0, state.rounds.length - state.currentRoundIndex - 1);
  const currentRoundRemainingSec = state.inIntermission
    ? state.intermissionLeftSec
    : state.timeLeftSec + (remainingFutureRounds > 0 ? state.intermissionSeconds : 0);

  const futureRoundsSec =
    remainingFutureRounds * state.gameDurationSec +
    Math.max(0, remainingFutureRounds - 1) * state.intermissionSeconds;

  const totalRemainingSec = currentRoundRemainingSec + futureRoundsSec;
  const finishDate = new Date(Date.now() + totalRemainingSec * 1000);
  return `${String(finishDate.getHours()).padStart(2, "0")}:${String(finishDate.getMinutes()).padStart(2, "0")}`;
}

function initSetupDefaults() {
  const future = new Date(Date.now() + 50 * 60 * 1000);
  state.desiredFinishTime = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
  const finishInput = document.getElementById("desiredFinishTimeInput");
  if (finishInput) finishInput.value = state.desiredFinishTime;
}

function renderSetupView() {
  document.getElementById("selectedTeamsBadge").textContent = `${state.numTeams} Teams`;

  document.querySelectorAll(".team-count-btn").forEach((btn) => {
    const count = parseInt(btn.getAttribute("data-teams"), 10);
    btn.className =
      count === state.numTeams
        ? "team-count-btn rounded-xl border-2 border-gold-500 bg-gold-500/20 text-white py-2.5 font-black text-sm transition shadow-md"
        : "team-count-btn rounded-xl border-2 border-slate-700 bg-navy-950/60 text-slate-300 hover:border-slate-500 py-2.5 font-black text-sm transition";
  });

  const countA = Math.ceil(state.numTeams / 2);
  const countB = state.numTeams - countA;
  const groupDesc = document.getElementById("groupFormatDesc");
  if (groupDesc) {
    groupDesc.textContent =
      countA === countB
        ? `2 Groups of ${countA} + Placement Finals`
        : `Group A (${countA}) & Group B (${countB}) + Top ${countB} Finals`;
  }

  document.querySelectorAll(".format-btn").forEach((btn) => {
    const fmt = btn.getAttribute("data-format");
    const radio = btn.querySelector(".format-radio");
    const dot = btn.querySelector(".format-dot");
    if (fmt === state.format) {
      btn.className = "format-btn w-full text-left rounded-2xl border-2 border-gold-500 bg-gold-500/15 p-4 transition flex items-start gap-3.5 shadow-md";
      radio.className = "mt-0.5 w-5 h-5 rounded-full border-2 border-gold-500 flex items-center justify-center shrink-0 format-radio";
      dot.classList.remove("hidden");
    } else {
      btn.className = "format-btn w-full text-left rounded-2xl border-2 border-slate-700 bg-navy-950/50 hover:border-slate-500 p-4 transition flex items-start gap-3.5";
      radio.className = "mt-0.5 w-5 h-5 rounded-full border-2 border-slate-500 flex items-center justify-center shrink-0 format-radio";
      dot.classList.add("hidden");
    }
  });

  document.querySelectorAll(".timing-mode-btn").forEach((btn) => {
    const mode = btn.getAttribute("data-timing");
    btn.className =
      mode === state.timingMode
        ? "timing-mode-btn rounded-xl border-2 border-gold-500 bg-gold-500/20 text-white py-2.5 px-3 text-xs font-black uppercase tracking-wider transition"
        : "timing-mode-btn rounded-xl border-2 border-slate-700 bg-navy-950/60 text-slate-400 hover:border-slate-500 py-2.5 px-3 text-xs font-black uppercase tracking-wider transition";
  });

  document.getElementById("finishTimePanel").classList.toggle("hidden", state.timingMode !== "finish");
  document.getElementById("manualDurationPanel").classList.toggle("hidden", state.timingMode !== "manual");

  document.querySelectorAll(".court-count-btn").forEach((btn) => {
    const c = parseInt(btn.getAttribute("data-courts"), 10);
    btn.className =
      c === state.numCourts
        ? "court-count-btn rounded-xl border-2 border-gold-500 bg-gold-500/20 text-white py-3 font-black text-sm transition shadow-md"
        : "court-count-btn rounded-xl border-2 border-slate-700 bg-navy-950/60 text-slate-300 hover:border-slate-500 py-3 font-black text-sm transition";
  });

  const teamContainer = document.getElementById("teamNamesContainer");
  teamContainer.innerHTML = "";
  for (let i = 0; i < state.numTeams; i++) {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2";
    const isGroupA = i < countA;
    const groupTag =
      state.format === "groups"
        ? `<span class="text-[10px] font-black uppercase px-2 py-0.5 rounded shrink-0 ${
            isGroupA
              ? "bg-navy-800 text-gold-400 border border-gold-500/30"
              : "bg-slate-800 text-slate-300 border border-slate-700"
          }">${isGroupA ? "Grp A" : "Grp B"}</span>`
        : "";
    row.innerHTML = `
      <span class="w-5 text-xs font-black text-slate-400">${i + 1}.</span>
      <input type="text" data-team-idx="${i}" value="${state.teamNames[i] || `Team ${i + 1}`}"
        class="team-name-input flex-1 min-w-0 rounded-xl border border-slate-700 bg-navy-950 px-3 py-2 text-sm font-bold text-white focus:border-gold-500 focus:outline-none transition" />
      ${groupTag}
    `;
    teamContainer.appendChild(row);
  }

  document.querySelectorAll(".team-name-input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(e.target.getAttribute("data-team-idx"), 10);
      state.teamNames[idx] = e.target.value;
    });
  });

  const courtContainer = document.getElementById("courtNamesContainer");
  courtContainer.innerHTML = "";
  for (let i = 0; i < state.numCourts; i++) {
    const div = document.createElement("div");
    div.className = "flex items-center gap-2.5";
    div.innerHTML = `
      <span class="text-xs font-black text-slate-400">${i + 1}.</span>
      <input type="text" data-court-idx="${i}" value="${state.courtNames[i] || `Court ${i + 1}`}"
        class="court-name-input flex-1 rounded-xl border border-slate-700 bg-navy-950 px-3.5 py-2.5 text-sm font-bold text-white focus:border-gold-500 focus:outline-none transition" />
    `;
    courtContainer.appendChild(div);
  }

  document.querySelectorAll(".court-name-input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(e.target.getAttribute("data-court-idx"), 10);
      state.courtNames[idx] = e.target.value;
    });
  });

  const previewRounds = buildTournamentSchedule();
  const previewSec = calculateGameDurationSeconds(previewRounds.length);
  document.getElementById("calcRoundsBadge").textContent = `${previewRounds.length} Rounds • ${formatMMSS(previewSec)} / game`;
  const autoText = document.getElementById("autoCalcGameTimeText");
  if (autoText) {
    autoText.textContent = `Auto-calculated: ${formatMMSS(previewSec)} per game across ${previewRounds.length} rounds.`;
  }
}

function renderArenaView() {
  updateFinalsSeedingIfReady();

  const totalRounds = state.rounds.length;
  const currentRound = state.rounds[state.currentRoundIndex] || [];
  const nextRound = state.rounds[state.currentRoundIndex + 1] || [];
  const stageLabel = currentRound[0] ? currentRound[0].stage : "TOURNAMENT";

  document.getElementById("headerTitle").textContent = state.title || "PE TOURNAMENT";
  const roundText = `ROUND ${state.currentRoundIndex + 1} / ${totalRounds} (${stageLabel})`;
  document.getElementById("livePhaseBadge").textContent = roundText;
  document.getElementById("roundBottomLabel").textContent = roundText;
  document.getElementById("expectedFinishLabel").textContent = `Expected Finish: ${getExpectedFinishTimeString()}`;

  const autoAdvLabel = document.getElementById("autoAdvanceLabelText");
  if (autoAdvLabel) {
    autoAdvLabel.textContent = `Auto-Advance on Timer End (${state.intermissionSeconds}s Score View)`;
  }

  document.getElementById("mainTimerDisplay").textContent = formatMMSS(state.timeLeftSec);
  document.getElementById("playPauseIcon").textContent = state.timerRunning ? "⏸" : "▶";
  document.getElementById("playPauseText").textContent = state.timerRunning ? "PAUSE" : "START";

  const intermissionBanner = document.getElementById("intermissionBanner");
  const timerCard = document.getElementById("timerCard");
  if (state.inIntermission) {
    intermissionBanner.classList.remove("hidden");
    document.getElementById("intermissionCountdown").textContent = state.intermissionLeftSec;
    timerCard.classList.add("intermission-glow", "border-gold-500");
  } else {
    intermissionBanner.classList.add("hidden");
    timerCard.classList.remove("intermission-glow", "border-gold-500");
  }

  document.getElementById("prevRoundBtn").disabled = state.currentRoundIndex <= 0;
  const nextBtnText = document.getElementById("nextRoundBtnText");
  nextBtnText.textContent =
    state.currentRoundIndex >= totalRounds - 1
      ? "FINISH TOURNAMENT"
      : state.inIntermission
      ? "SKIP WAIT & START NEXT ROUND"
      : "NEXT ROUND";

  const courtsGrid = document.getElementById("courtsGrid");
  courtsGrid.innerHTML = "";
  courtsGrid.className =
    state.numCourts === 1
      ? "grid grid-cols-1 max-w-2xl mx-auto gap-6"
      : "grid grid-cols-1 lg:grid-cols-2 gap-6";

  for (let cIdx = 0; cIdx < state.numCourts; cIdx++) {
    const courtName = state.courtNames[cIdx] || `Court ${cIdx + 1}`;
    const match = currentRound[cIdx];
    const upNextMatch = nextRound[cIdx];

    const card = document.createElement("div");
    card.className = `rounded-3xl border-2 ${
      state.inIntermission ? "border-gold-500 bg-navy-900" : "border-slate-700/90 bg-navy-900/90"
    } p-6 shadow-2xl flex flex-col justify-between transition-all`;

    if (!match) {
      card.innerHTML = `
        <div>
          <div class="flex items-center justify-between border-b border-slate-800 pb-3 mb-6">
            <h3 class="text-xl font-black uppercase tracking-wider text-slate-400">${courtName}</h3>
            <span class="text-xs font-bold uppercase px-2.5 py-1 rounded-full bg-slate-800 text-slate-400">Idle</span>
          </div>
          <p class="text-center text-slate-500 font-bold py-8">No Match Needed on ${courtName} This Round</p>
        </div>
      `;
    } else {
      const upNextHTML = upNextMatch
        ? `<div class="mt-6 pt-4 border-t border-slate-800 flex items-center justify-between">
             <div>
               <div class="text-[10px] font-black uppercase tracking-widest text-slate-400">UP NEXT</div>
               <div class="text-sm font-extrabold italic text-slate-200 mt-0.5">${upNextMatch.teamA} <span class="text-xs font-normal not-italic text-slate-400 px-1">vs</span> ${upNextMatch.teamB}</div>
             </div>
             <span class="text-[11px] font-bold text-slate-400">${upNextMatch.groupLabel}</span>
           </div>`
        : `<div class="mt-6 pt-4 border-t border-slate-800 text-xs font-bold text-slate-500 uppercase tracking-wider">Final Scheduled Match on ${courtName}</div>`;

      card.innerHTML = `
        <div>
          <div class="flex items-center justify-between border-b border-slate-800 pb-3 mb-5">
            <h3 class="text-2xl font-black uppercase tracking-wider text-white">${courtName}</h3>
            <span class="text-xs font-black uppercase tracking-widest px-3 py-1 rounded-full bg-navy-800 text-gold-400 border border-gold-500/30">${match.groupLabel}</span>
          </div>

          <div class="space-y-5">
            <div class="flex items-center justify-between gap-3">
              <span class="text-xl sm:text-2xl font-black text-white truncate">${match.teamA}</span>
              <div class="flex items-center gap-3 shrink-0">
                <button type="button" data-match-id="${match.id}" data-team="A" data-delta="-1"
                  class="score-btn w-11 h-11 rounded-xl border-2 border-slate-600 hover:border-gold-500 bg-navy-950 text-xl font-black text-slate-200 flex items-center justify-center transition active:scale-95">−</button>
                <span class="timer-digits text-4xl sm:text-5xl font-black text-gold-400 w-12 text-center">${match.scoreA}</span>
                <button type="button" data-match-id="${match.id}" data-team="A" data-delta="1"
                  class="score-btn w-11 h-11 rounded-xl border-2 border-slate-600 hover:border-gold-500 bg-navy-800 hover:bg-gold-500 hover:text-navy-950 text-xl font-black text-white flex items-center justify-center transition active:scale-95">+</button>
              </div>
            </div>

            <div class="flex items-center justify-between gap-3">
              <span class="text-xl sm:text-2xl font-black text-white truncate">${match.teamB}</span>
              <div class="flex items-center gap-3 shrink-0">
                <button type="button" data-match-id="${match.id}" data-team="B" data-delta="-1"
                  class="score-btn w-11 h-11 rounded-xl border-2 border-slate-600 hover:border-gold-500 bg-navy-950 text-xl font-black text-slate-200 flex items-center justify-center transition active:scale-95">−</button>
                <span class="timer-digits text-4xl sm:text-5xl font-black text-gold-400 w-12 text-center">${match.scoreB}</span>
                <button type="button" data-match-id="${match.id}" data-team="B" data-delta="1"
                  class="score-btn w-11 h-11 rounded-xl border-2 border-slate-600 hover:border-gold-500 bg-navy-800 hover:bg-gold-500 hover:text-navy-950 text-xl font-black text-white flex items-center justify-center transition active:scale-95">+</button>
              </div>
            </div>
          </div>
        </div>
        ${upNextHTML}
      `;
    }
    courtsGrid.appendChild(card);
  }

  renderFixturesList();
  renderStandingsTables();

  document.querySelectorAll(".score-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mId = parseInt(btn.getAttribute("data-match-id"), 10);
      const side = btn.getAttribute("data-team");
      const delta = parseInt(btn.getAttribute("data-delta"), 10);
      adjustMatchScore(mId, side, delta);
    });
  });
}

function adjustMatchScore(matchId, side, delta) {
  state.rounds.forEach((rnd) => {
    rnd.forEach((m) => {
      if (m.id === matchId) {
        if (side === "A") m.scoreA = Math.max(0, m.scoreA + delta);
        else m.scoreB = Math.max(0, m.scoreB + delta);
        m.edited = m.scoreA > 0 || m.scoreB > 0;
      }
    });
  });
  renderArenaView();
}

function renderFixturesList() {
  const container = document.getElementById("fixturesListContainer");
  container.innerHTML = "";

  let lastStage = "";
  state.rounds.forEach((rnd, rIdx) => {
    const isCurrentRound = rIdx === state.currentRoundIndex;

    rnd.forEach((m) => {
      if (m.stage !== lastStage) {
        lastStage = m.stage;
        const divider = document.createElement("div");
        divider.className = "text-[11px] font-black uppercase tracking-widest text-center text-gold-400 bg-navy-950/90 py-1.5 my-2 rounded-lg border border-slate-800";
        divider.textContent = m.stage;
        container.appendChild(divider);
      }

      const row = document.createElement("div");
      row.className = `flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-xs transition ${
        isCurrentRound
          ? "bg-navy-800/40 border-gold-500/60 text-white font-bold"
          : "bg-navy-950/40 border-slate-800/80 text-slate-300"
      }`;

      row.innerHTML = `
        <div class="flex items-center gap-2 min-w-[85px]">
          <span class="font-black text-slate-400">R${m.roundNumber}</span>
          <span class="text-[11px] text-slate-400 truncate">${m.groupLabel}</span>
        </div>
        <div class="flex-1 flex items-center justify-end gap-2 truncate">
          <span class="truncate font-bold">${m.teamA}</span>
          <div class="flex flex-col leading-none">
            <button type="button" data-match-id="${m.id}" data-team="A" data-delta="1" class="score-btn text-[10px] hover:text-gold-400">▲</button>
            <button type="button" data-match-id="${m.id}" data-team="A" data-delta="-1" class="score-btn text-[10px] hover:text-gold-400">▼</button>
          </div>
        </div>
        <div class="flex items-center gap-1.5 px-2">
          <span class="px-2 py-1 rounded-lg bg-navy-950 border border-slate-700 font-black text-gold-400">${m.scoreA}</span>
          <span class="text-slate-500">-</span>
          <span class="px-2 py-1 rounded-lg bg-navy-950 border border-slate-700 font-black text-gold-400">${m.scoreB}</span>
        </div>
        <div class="flex-1 flex items-center justify-start gap-2 truncate">
          <div class="flex flex-col leading-none">
            <button type="button" data-match-id="${m.id}" data-team="B" data-delta="1" class="score-btn text-[10px] hover:text-gold-400">▲</button>
            <button type="button" data-match-id="${m.id}" data-team="B" data-delta="-1" class="score-btn text-[10px] hover:text-gold-400">▼</button>
          </div>
          <span class="truncate font-bold">${m.teamB}</span>
        </div>
      `;
      container.appendChild(row);
    });
  });
}

function createStandingsTableHTML(title, rows) {
  const trs = rows
    .map(
      (r, idx) => `
    <tr class="border-b border-slate-800/80 ${idx === 0 ? "bg-gold-500/10" : ""}">
      <td class="py-2.5 px-2 font-black text-slate-400">${idx + 1}</td>
      <td class="py-2.5 px-2 font-extrabold text-white">${r.team}</td>
      <td class="py-2.5 px-2 text-center text-slate-300">${r.P}</td>
      <td class="py-2.5 px-2 text-center text-slate-300">${r.W}</td>
      <td class="py-2.5 px-2 text-center text-slate-300">${r.D}</td>
      <td class="py-2.5 px-2 text-center text-slate-300">${r.L}</td>
      <td class="py-2.5 px-2 text-center text-slate-300">${r.GD > 0 ? `+${r.GD}` : r.GD}</td>
      <td class="py-2.5 px-2 text-center font-black text-gold-400 text-sm">${r.Pts}</td>
    </tr>
  `
    )
    .join("");

  return `
    <div class="rounded-3xl border-2 border-slate-800 bg-navy-900/90 p-5 sm:p-6 shadow-xl">
      <div class="flex items-center justify-between mb-3 pb-2.5 border-b border-slate-800">
        <h3 class="text-sm font-black uppercase tracking-widest text-white">${title}</h3>
        <span>🏆</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs text-left">
          <thead>
            <tr class="border-b border-slate-700 text-slate-400 uppercase font-black">
              <th class="py-2 px-2">Pos</th>
              <th class="py-2 px-2">Team</th>
              <th class="py-2 px-2 text-center">P</th>
              <th class="py-2 px-2 text-center">W</th>
              <th class="py-2 px-2 text-center">D</th>
              <th class="py-2 px-2 text-center">L</th>
              <th class="py-2 px-2 text-center">GD</th>
              <th class="py-2 px-2 text-center">Pts</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderStandingsTables() {
  const container = document.getElementById("standingsContainer");
  const activeTeams = getSanitizedActiveTeams();

  if (state.format === "roundrobin") {
    const standings = computeGroupStandings(activeTeams, null);
    container.innerHTML = createStandingsTableHTML("LEAGUE STANDINGS", standings);
  } else {
    const half = Math.ceil(activeTeams.length / 2);
    const groupA = activeTeams.slice(0, half);
    const groupB = activeTeams.slice(half);
    const stA = computeGroupStandings(groupA, "Group A");
    const stB = computeGroupStandings(groupB, "Group B");
    container.innerHTML =
      createStandingsTableHTML("GROUP A STANDINGS", stA) +
      createStandingsTableHTML("GROUP B STANDINGS", stB);
  }
}

function startTimerLoop() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    if (!state.timerRunning) return;

    if (!state.inIntermission) {
      if (state.timeLeftSec > 0) {
        state.timeLeftSec -= 1;
        if (state.timeLeftSec > 0 && state.timeLeftSec <= 3) playCountdownPip(880, 0.1);
        renderArenaView();
      }

      if (state.timeLeftSec === 0) {
        const currentRound = state.rounds[state.currentRoundIndex] || [];
        currentRound.forEach((m) => (m.completed = true));
        playArenaBuzzer();

        if (state.autoAdvance && state.currentRoundIndex < state.rounds.length - 1) {
          state.inIntermission = true;
          state.intermissionLeftSec = state.intermissionSeconds;
          renderArenaView();
        } else {
          state.timerRunning = false;
          renderArenaView();
        }
      }
    } else {
      if (state.intermissionLeftSec > 0) {
        state.intermissionLeftSec -= 1;
        renderArenaView();
      }
      if (state.intermissionLeftSec <= 0) {
        advanceToRound(state.currentRoundIndex + 1, true);
      }
    }
  }, 1000);
}

function advanceToRound(targetIndex, autoStartClock = false) {
  if (targetIndex > state.currentRoundIndex && state.rounds[state.currentRoundIndex]) {
    state.rounds[state.currentRoundIndex].forEach((m) => (m.completed = true));
  }

  if (targetIndex < 0 || targetIndex >= state.rounds.length) {
    state.timerRunning = false;
    state.inIntermission = false;
    renderArenaView();
    return;
  }

  state.currentRoundIndex = targetIndex;
  state.inIntermission = false;
  state.timeLeftSec = state.gameDurationSec;
  state.timerRunning = autoStartClock;

  if (autoStartClock) playStartWhistle();
  renderArenaView();
}

document.addEventListener("DOMContentLoaded", () => {
  initSetupDefaults();
  renderSetupView();
  startTimerLoop();

  document.getElementById("tournamentTitleInput").addEventListener("input", (e) => {
    state.title = e.target.value;
    document.getElementById("headerTitle").textContent = state.title || "PE TOURNAMENT";
  });

  document.querySelectorAll(".team-count-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.numTeams = parseInt(btn.getAttribute("data-teams"), 10);
      renderSetupView();
    });
  });

  document.querySelectorAll(".format-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.format = btn.getAttribute("data-format");
      renderSetupView();
    });
  });

  document.querySelectorAll(".timing-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.timingMode = btn.getAttribute("data-timing");
      renderSetupView();
    });
  });

  document.querySelectorAll('input[name="startTimeMode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      state.startTimeMode = e.target.value;
      document
        .getElementById("customStartTimeInput")
        .classList.toggle("hidden", state.startTimeMode !== "custom");
      renderSetupView();
    });
  });

  document.getElementById("customStartTimeInput").addEventListener("input", (e) => {
    state.customStartTime = e.target.value;
    renderSetupView();
  });

  document.getElementById("desiredFinishTimeInput").addEventListener("input", (e) => {
    state.desiredFinishTime = e.target.value;
    renderSetupView();
  });

  document.getElementById("manualMinutesInput").addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    state.manualMinutes = isNaN(val) ? 0 : Math.max(0, val);
    renderSetupView();
  });

  document.getElementById("manualSecondsInput").addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    state.manualSeconds = isNaN(val) ? 0 : Math.max(0, val);
    renderSetupView();
  });

  document.getElementById("intermissionSecInput").addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    state.intermissionSeconds = isNaN(val) ? 10 : Math.max(3, val);
    renderSetupView();
  });

  document.querySelectorAll(".court-count-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.numCourts = parseInt(btn.getAttribute("data-courts"), 10);
      renderSetupView();
    });
  });

  document.getElementById("presetNamesBtn").addEventListener("click", () => {
    state.teamNames = [...FUN_PE_NAMES];
    renderSetupView();
  });

  document.getElementById("resetDefaultNamesBtn").addEventListener("click", () => {
    state.teamNames = Array.from({ length: 12 }, (_, i) => `Team ${i + 1}`);
    renderSetupView();
  });

  document.getElementById("startTournamentBtn").addEventListener("click", () => {
    ensureAudioContext();
    state.rounds = buildTournamentSchedule();
    state.gameDurationSec = calculateGameDurationSeconds(state.rounds.length);
    state.timeLeftSec = state.gameDurationSec;
    state.currentRoundIndex = 0;
    state.inIntermission = false;
    state.timerRunning = true;

    document.getElementById("setupView").classList.add("hidden");
    document.getElementById("arenaView").classList.remove("hidden");
    document.getElementById("setupToggleBtn").classList.remove("hidden");

    playStartWhistle();
    renderArenaView();
  });

  document.getElementById("setupToggleBtn").addEventListener("click", () => {
    state.timerRunning = false;
    state.inIntermission = false;
    document.getElementById("arenaView").classList.add("hidden");
    document.getElementById("setupView").classList.remove("hidden");
    renderSetupView();
  });

  document.getElementById("playPauseBtn").addEventListener("click", () => {
    ensureAudioContext();
    state.timerRunning = !state.timerRunning;
    renderArenaView();
  });

  document.getElementById("resetTimerBtn").addEventListener("click", () => {
    state.timerRunning = false;
    state.inIntermission = false;
    state.timeLeftSec = state.gameDurationSec;
    renderArenaView();
  });

  document.getElementById("hornManualBtn").addEventListener("click", playArenaBuzzer);
  document.getElementById("testSoundBtn").addEventListener("click", playArenaBuzzer);

  document.getElementById("autoAdvanceCheckbox").addEventListener("change", (e) => {
    state.autoAdvance = e.target.checked;
  });

  document.getElementById("nextRoundBtn").addEventListener("click", () => {
    ensureAudioContext();
    if (state.currentRoundIndex < state.rounds.length - 1) {
      advanceToRound(state.currentRoundIndex + 1, state.timerRunning);
    } else {
      if (state.rounds[state.currentRoundIndex]) {
        state.rounds[state.currentRoundIndex].forEach((m) => (m.completed = true));
      }
      state.timerRunning = false;
      state.inIntermission = false;
      playArenaBuzzer();
      renderArenaView();
    }
  });

  document.getElementById("prevRoundBtn").addEventListener("click", () => {
    if (state.currentRoundIndex > 0) advanceToRound(state.currentRoundIndex - 1, false);
  });

  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    state.darkMode = !state.darkMode;
    const body = document.body;
    const btn = document.getElementById("themeToggleBtn");
    if (state.darkMode) {
      body.classList.remove("bg-slate-100", "text-slate-900");
      body.classList.add("bg-navy-950", "text-slate-100");
      btn.textContent = "☀️";
    } else {
      body.classList.remove("bg-navy-950", "text-slate-100");
      body.classList.add("bg-slate-100", "text-slate-900");
      btn.textContent = "🌙";
    }
  });
});
