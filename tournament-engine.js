/**
 * MULTI-SPORT TOURNAMENT & REVERSE-TIME ENGINE (tournament-engine.js)
 * Supports 4-12 Teams, 1-6 Courts, Single Round-Robin or 2-Pool formats,
 * automatic game-duration calculation from target finish time, and live delay recalculation.
 */

const TOURNAMENT_STORAGE_KEY = 'SPORT_TOURNAMENT_STATE_V1';

class TournamentEngine {
  constructor() {
    this.state = this.loadState() || this.getInitialState();
  }

  getInitialState() {
    return {
      config: {
        title: 'Inter-House / Varsity Cup',
        sport: 'Football / Basketball / Volleyball',
        format: 'SINGLE_RR_FINALS', // 'SINGLE_RR_FINALS' | 'TWO_POOLS_FINALS'
        numCourts: 2,
        startTime: '09:00',
        endTime: '14:30',
        bufferMins: 3,
        ptsWin: 3,
        ptsDraw: 1,
        ptsLoss: 0
      },
      stage: 'SETUP', // SETUP | GROUP_STAGE | SEMIFINALS | FINALS | COMPLETE
      teams: [
        { id: 'T1', name: 'Team 1', pool: 'Pool A' },
        { id: 'T2', name: 'Team 2', pool: 'Pool A' },
        { id: 'T3', name: 'Team 3', pool: 'Pool A' },
        { id: 'T4', name: 'Team 4', pool: 'Pool A' },
        { id: 'T5', name: 'Team 5', pool: 'Pool A' },
        { id: 'T6', name: 'Team 6', pool: 'Pool A' }
      ],
      scheduleStats: {
        totalAvailableMins: 0,
        totalSlots: 0,
        groupSlots: 0,
        knockoutSlots: 0,
        gameDurationMins: 0,
        slotDurationMins: 0,
        warning: null
      },
      slots: [], // [{ slotNumber, startTime, endTime, stage, matches: [...] }]
      activeSlotNumber: 1
    };
  }

  saveState() {
    localStorage.setItem(TOURNAMENT_STORAGE_KEY, JSON.stringify(this.state));
  }

  loadState() {
    try {
      const raw = localStorage.getItem(TOURNAMENT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('Failed to load tournament state', e);
      return null;
    }
  }

  resetAll() {
    this.state = this.getInitialState();
    this.saveState();
  }

  // ==========================================
  // 1. TIME HELPERS & REVERSE-CLOCK CALCULATOR
  // ==========================================
  timeToMins(timeStr) {
    const [h, m] = (timeStr || '09:00').split(':').map(Number);
    return h * 60 + m;
  }

  minsToTime(totalMins) {
    const wrapped = ((Math.round(totalMins) % 1440) + 1440) % 1440;
    const h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /**
   * Generates all round-robin pairings for a list of teams using the Berger/Circle method
   */
  generateRoundRobinPairings(teamsList, groupLabel) {
    const list = [...teamsList];
    if (list.length % 2 !== 0) {
      list.push({ id: 'BYE', name: 'BYE' });
    }
    const n = list.length;
    const numRounds = n - 1;
    const half = n / 2;
    const matches = [];

    for (let r = 0; r < numRounds; r++) {
      for (let i = 0; i < half; i++) {
        const tA = list[i];
        const tB = list[n - 1 - i];
        if (tA.id !== 'BYE' && tB.id !== 'BYE') {
          matches.push({
            id: `M_${groupLabel.replace(/\s+/g, '')}_R${r + 1}_${i + 1}`,
            stage: 'GROUP',
            group: groupLabel,
            roundHint: r + 1,
            teamAId: r % 2 === 0 ? tA.id : tB.id,
            teamBId: r % 2 === 0 ? tB.id : tA.id,
            scoreA: null,
            scoreB: null,
            status: 'PENDING'
          });
        }
      }
      // Rotate all except first element
      const last = list.pop();
      list.splice(1, 0, last);
    }
    return matches;
  }

  /**
   * Packs a list of matches into sequential Time Slots given C courts
   * Guarantees no team plays twice in the same time slot.
   */
  packMatchesIntoSlots(matchesQueue, numCourts) {
    const remaining = [...matchesQueue];
    const slots = [];

    while (remaining.length > 0) {
      const busyTeams = new Set();
      const slotMatches = [];

      for (let i = 0; i < remaining.length; i++) {
        if (slotMatches.length >= numCourts) break;
        const m = remaining[i];
        if (!busyTeams.has(m.teamAId) && !busyTeams.has(m.teamBId)) {
          busyTeams.add(m.teamAId);
          busyTeams.add(m.teamBId);
          slotMatches.push({
            ...m,
            court: slotMatches.length + 1
          });
          remaining.splice(i, 1);
          i--;
        }
      }
      slots.push({
        stage: 'GROUP',
        matches: slotMatches
      });
    }
    return slots;
  }

  /**
   * Dry-runs the schedule to calculate exact Game Duration before locking
   */
  previewTimingMetrics() {
    const { format, numCourts, startTime, endTime, bufferMins } = this.state.config;
    const teams = this.state.teams;
    const N = teams.length;

    // Assign pools cleanly
    let allGroupMatches = [];
    if (format === 'TWO_POOLS_FINALS' && N >= 6) {
      const poolA = [];
      const poolB = [];
      teams.forEach((t, idx) => {
        if (idx % 2 === 0) poolA.push(t);
        else poolB.push(t);
      });
      const matchesA = this.generateRoundRobinPairings(poolA, 'Pool A');
      const matchesB = this.generateRoundRobinPairings(poolB, 'Pool B');
      // Interleave Pool A and Pool B matches for balanced court rotation
      const maxLen = Math.max(matchesA.length, matchesB.length);
      for (let i = 0; i < maxLen; i++) {
        if (matchesA[i]) allGroupMatches.push(matchesA[i]);
        if (matchesB[i]) allGroupMatches.push(matchesB[i]);
      }
    } else {
      allGroupMatches = this.generateRoundRobinPairings(teams, 'League');
    }

    const packedGroupSlots = this.packMatchesIntoSlots(allGroupMatches, numCourts);
    const groupSlotsCount = packedGroupSlots.length;

    // Knockout slots:
    // Semifinals (2 games) = 1 slot if Courts >= 2, else 2 slots
    // Finals (Grand Final + 3rd Place Playoff = 2 games) = 1 slot if Courts >= 2, else 2 slots
    const semiSlotsCount = numCourts >= 2 ? 1 : 2;
    const finalSlotsCount = numCourts >= 2 ? 1 : 2;
    const knockoutSlotsCount = semiSlotsCount + finalSlotsCount;

    const totalSlots = groupSlotsCount + knockoutSlotsCount;
    const startMins = this.timeToMins(startTime);
    const endMins = this.timeToMins(endTime);
    const totalAvailableMins = Math.max(0, endMins - startMins);

    const exactSlotMins = totalSlots > 0 ? totalAvailableMins / totalSlots : 0;
    const rawGameMins = Math.floor(exactSlotMins - bufferMins);
    const gameDurationMins = Math.max(1, rawGameMins);

    let warning = null;
    if (totalAvailableMins <= 0) {
      warning = 'Finish time must be later than Start time.';
    } else if (rawGameMins < 4) {
      warning = `Tight schedule! With ${totalSlots} time slots, games are only ${Math.max(1, rawGameMins)} mins each. Consider adding a court, switching to 2 Pools, or extending the finish time.`;
    }

    return {
      totalMatches: allGroupMatches.length + 4,
      groupMatchesCount: allGroupMatches.length,
      totalAvailableMins,
      totalSlots,
      groupSlots: groupSlotsCount,
      knockoutSlots: knockoutSlotsCount,
      gameDurationMins,
      slotDurationMins: gameDurationMins + Number(bufferMins),
      warning,
      packedGroupSlots
    };
  }

  // ==========================================
  // 2. GENERATE TOURNAMENT & ASSIGN TIMESTAMPS
  // ==========================================
  setTeamCount(count) {
    const n = Math.max(4, Math.min(12, Number(count)));
    const current = this.state.teams;
    const nextTeams = [];
    for (let i = 0; i < n; i++) {
      const existing = current[i];
      const poolName = this.state.config.format === 'TWO_POOLS_FINALS'
        ? (i % 2 === 0 ? 'Pool A' : 'Pool B')
        : 'League';
      nextTeams.push({
        id: `T${i + 1}`,
        name: existing ? existing.name : `Team ${i + 1}`,
        pool: poolName
      });
    }
    this.state.teams = nextTeams;
    this.saveState();
  }

  startTournament() {
    // Update pool tags on teams
    this.state.teams.forEach((t, idx) => {
      t.pool = this.state.config.format === 'TWO_POOLS_FINALS' && this.state.teams.length >= 6
        ? (idx % 2 === 0 ? 'Pool A' : 'Pool B')
        : 'League';
    });

    const preview = this.previewTimingMetrics();
    this.state.scheduleStats = {
      totalAvailableMins: preview.totalAvailableMins,
      totalSlots: preview.totalSlots,
      groupSlots: preview.groupSlots,
      knockoutSlots: preview.knockoutSlots,
      gameDurationMins: preview.gameDurationMins,
      slotDurationMins: preview.slotDurationMins,
      warning: preview.warning
    };

    const allSlots = [...preview.packedGroupSlots];
    const numCourts = Number(this.state.config.numCourts);

    // Append Semifinal Slots
    const semiMatches = [
      {
        id: 'SEMI_1',
        stage: 'SEMIFINALS',
        group: 'Semifinal 1',
        label: 'Semifinal 1 (Seed #1 vs #4 / A1 vs B2)',
        teamAId: 'TBD',
        teamBId: 'TBD',
        scoreA: null,
        scoreB: null,
        status: 'PENDING'
      },
      {
        id: 'SEMI_2',
        stage: 'SEMIFINALS',
        group: 'Semifinal 2',
        label: 'Semifinal 2 (Seed #2 vs #3 / B1 vs A2)',
        teamAId: 'TBD',
        teamBId: 'TBD',
        scoreA: null,
        scoreB: null,
        status: 'PENDING'
      }
    ];

    if (numCourts >= 2) {
      allSlots.push({
        stage: 'SEMIFINALS',
        matches: [
          { ...semiMatches[0], court: 1 },
          { ...semiMatches[1], court: 2 }
        ]
      });
    } else {
      allSlots.push({ stage: 'SEMIFINALS', matches: [{ ...semiMatches[0], court: 1 }] });
      allSlots.push({ stage: 'SEMIFINALS', matches: [{ ...semiMatches[1], court: 1 }] });
    }

    // Append Finals Slots (Grand Final + 3rd Place Playoff)
    const finalMatches = [
      {
        id: 'GRAND_FINAL',
        stage: 'FINALS',
        group: '🏆 Grand Final',
        label: '🏆 Grand Final (1st Place Championship)',
        teamAId: 'TBD',
        teamBId: 'TBD',
        scoreA: null,
        scoreB: null,
        status: 'PENDING'
      },
      {
        id: 'THIRD_PLACE',
        stage: 'FINALS',
        group: '🥉 3rd Place Playoff',
        label: '🥉 Bronze Match (3rd Place Playoff)',
        teamAId: 'TBD',
        teamBId: 'TBD',
        scoreA: null,
        scoreB: null,
        status: 'PENDING'
      }
    ];

    if (numCourts >= 2) {
      allSlots.push({
        stage: 'FINALS',
        matches: [
          { ...finalMatches[0], court: 1 },
          { ...finalMatches[1], court: 2 }
        ]
      });
    } else {
      allSlots.push({ stage: 'FINALS', matches: [{ ...finalMatches[1], court: 1 }] });
      allSlots.push({ stage: 'FINALS', matches: [{ ...finalMatches[0], court: 1 }] });
    }

    // Stamp exact clock times onto each slot
    const startMins = this.timeToMins(this.state.config.startTime);
    const gameMins = preview.gameDurationMins;
    const slotStep = preview.slotDurationMins;

    this.state.slots = allSlots.map((slot, idx) => {
      const slotStart = startMins + idx * slotStep;
      const slotEnd = slotStart + gameMins;
      return {
        slotNumber: idx + 1,
        stage: slot.stage,
        startTime: this.minsToTime(slotStart),
        endTime: this.minsToTime(slotEnd),
        matches: slot.matches
      };
    });

    this.state.stage = 'GROUP_STAGE';
    this.state.activeSlotNumber = 1;
    this.saveState();
  }

  /**
   * Live Delay Recalculator: Re-divides remaining time from `newCurrentTimeStr` to `config.endTime`
   * across all uncompleted slots so you still finish on time!
   */
  recalculateRemainingClock(newCurrentTimeStr) {
    const pendingSlots = this.state.slots.filter(s =>
      s.matches.some(m => m.status !== 'COMPLETED')
    );
    if (pendingSlots.length === 0) return;

    const nowMins = this.timeToMins(newCurrentTimeStr);
    const endMins = this.timeToMins(this.state.config.endTime);
    const buffer = Number(this.state.config.bufferMins);
    const remainingWindow = Math.max(pendingSlots.length * 3, endMins - nowMins);

    const newSlotStep = Math.floor(remainingWindow / pendingSlots.length);
    const newGameMins = Math.max(1, newSlotStep - buffer);

    this.state.scheduleStats.gameDurationMins = newGameMins;
    this.state.scheduleStats.slotDurationMins = newGameMins + buffer;

    pendingSlots.forEach((slot, idx) => {
      const sStart = nowMins + idx * (newGameMins + buffer);
      const sEnd = sStart + newGameMins;
      slot.startTime = this.minsToTime(sStart);
      slot.endTime = this.minsToTime(sEnd);
    });

    this.saveState();
  }

  // ==========================================
  // 3. SCORING, STANDINGS & KNOCKOUT SEEDING
  // ==========================================
  recordMatchScore(matchId, scoreA, scoreB) {
    for (const slot of this.state.slots) {
      const match = slot.matches.find(m => m.id === matchId);
      if (match) {
        match.scoreA = Number(scoreA);
        match.scoreB = Number(scoreB);
        match.status = 'COMPLETED';
        break;
      }
    }

    // Auto-advance activeSlotNumber if all matches in current slot are done
    const nextPendingSlot = this.state.slots.find(s =>
      s.matches.some(m => m.status !== 'COMPLETED')
    );
    if (nextPendingSlot) {
      this.state.activeSlotNumber = nextPendingSlot.slotNumber;
    }

    this.saveState();
  }

  getTeamName(teamId) {
    if (!teamId || teamId === 'TBD') return 'TBD';
    const t = this.state.teams.find(team => team.id === teamId);
    return t ? t.name : teamId;
  }

  /**
   * Calculates standings table for a given group ('League', 'Pool A', 'Pool B')
   * Sorts by: 1. Points, 2. Goal/Point Difference (GD), 3. Goals For (GF), 4. Head-to-Head
   */
  getGroupStandings(groupName) {
    const { ptsWin, ptsDraw, ptsLoss } = this.state.config;
    const groupTeams = this.state.teams.filter(t => t.pool === groupName);

    const completedGroupMatches = [];
    this.state.slots.forEach(s => {
      s.matches.forEach(m => {
        if (m.stage === 'GROUP' && m.group === groupName && m.status === 'COMPLETED') {
          completedGroupMatches.push(m);
        }
      });
    });

    const table = groupTeams.map(team => {
      let played = 0, won = 0, drawn = 0, lost = 0, gf = 0, ga = 0, pts = 0;

      completedGroupMatches.forEach(m => {
        if (m.teamAId === team.id || m.teamBId === team.id) {
          played++;
          const myScore = m.teamAId === team.id ? m.scoreA : m.scoreB;
          const oppScore = m.teamAId === team.id ? m.scoreB : m.scoreA;
          gf += myScore;
          ga += oppScore;
          if (myScore > oppScore) {
            won++;
            pts += Number(ptsWin);
          } else if (myScore === oppScore) {
            drawn++;
            pts += Number(ptsDraw);
          } else {
            lost++;
            pts += Number(ptsLoss);
          }
        }
      });

      return {
        teamId: team.id,
        teamName: team.name,
        pool: team.pool,
        played,
        won,
        drawn,
        lost,
        gf,
        ga,
        gd: gf - ga,
        pts
      };
    });

    table.sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return a.teamName.localeCompare(b.teamName);
    });

    return table;
  }

  /**
   * Populates Semifinal 1 and Semifinal 2 from Group Standings
   */
  seedSemifinals() {
    let semi1A, semi1B, semi2A, semi2B;

    if (this.state.config.format === 'TWO_POOLS_FINALS' && this.state.teams.length >= 6) {
      const poolA = this.getGroupStandings('Pool A');
      const poolB = this.getGroupStandings('Pool B');
      // Cross-pool semifinals: A1 vs B2, B1 vs A2
      semi1A = poolA[0]?.teamId || 'TBD';
      semi1B = poolB[1]?.teamId || 'TBD';
      semi2A = poolB[0]?.teamId || 'TBD';
      semi2B = poolA[1]?.teamId || 'TBD';
    } else {
      const league = this.getGroupStandings('League');
      // Standard 1v4, 2v3
      semi1A = league[0]?.teamId || 'TBD';
      semi1B = league[3]?.teamId || 'TBD';
      semi2A = league[1]?.teamId || 'TBD';
      semi2B = league[2]?.teamId || 'TBD';
    }

    this.state.slots.forEach(s => {
      s.matches.forEach(m => {
        if (m.id === 'SEMI_1') {
          m.teamAId = semi1A;
          m.teamBId = semi1B;
        } else if (m.id === 'SEMI_2') {
          m.teamAId = semi2A;
          m.teamBId = semi2B;
        }
      });
    });

    this.state.stage = 'SEMIFINALS';
    const firstSemiSlot = this.state.slots.find(s => s.stage === 'SEMIFINALS');
    if (firstSemiSlot) this.state.activeSlotNumber = firstSemiSlot.slotNumber;
    this.saveState();
  }

  /**
   * Populates Grand Final (Winners of Semis) and 3rd Place Playoff (Losers of Semis)
   */
  seedFinals() {
    let semi1 = null, semi2 = null;
    this.state.slots.forEach(s => {
      s.matches.forEach(m => {
        if (m.id === 'SEMI_1') semi1 = m;
        if (m.id === 'SEMI_2') semi2 = m;
      });
    });

    if (!semi1 || !semi2 || semi1.status !== 'COMPLETED' || semi2.status !== 'COMPLETED') {
      return false;
    }

    const winner1 = semi1.scoreA >= semi1.scoreB ? semi1.teamAId : semi1.teamBId;
    const loser1  = semi1.scoreA >= semi1.scoreB ? semi1.teamBId : semi1.teamAId;
    const winner2 = semi2.scoreA >= semi2.scoreB ? semi2.teamAId : semi2.teamBId;
    const loser2  = semi2.scoreA >= semi2.scoreB ? semi2.teamBId : semi2.teamAId;

    this.state.slots.forEach(s => {
      s.matches.forEach(m => {
        if (m.id === 'GRAND_FINAL') {
          m.teamAId = winner1;
          m.teamBId = winner2;
        } else if (m.id === 'THIRD_PLACE') {
          m.teamAId = loser1;
          m.teamBId = loser2;
        }
      });
    });

    this.state.stage = 'FINALS';
    const firstFinalSlot = this.state.slots.find(s => s.stage === 'FINALS');
    if (firstFinalSlot) this.state.activeSlotNumber = firstFinalSlot.slotNumber;
    this.saveState();
    return true;
  }
}

window.TournamentEngine = TournamentEngine;
