/* Single-game PGN import (roadmap #23, Phase 4): parse + validate in memory,
 * then commit ONCE or not at all, deduped so a repeated import is one game. */
'use strict';
require('./helper').run('import', async function (t) {
  const page = t.page, check = t.check;

  async function importCount() {
    return page.evaluate(function () {
      return CoachStore.listGames().then(function (gs) {
        return gs.filter(function (g) { return g.source === 'import'; }).length;
      });
    });
  }

  check(await page.evaluate(function () {
    return typeof ChessyPGN !== 'undefined' && typeof CoachStore.importGame === 'function';
  }), 'the PGN module and importGame are loaded');

  const pgn = [
    '[Event "Test"]', '[White "Alice"]', '[Black "Bob"]', '[Result "1-0"]',
    '[TimeControl "180+2"]', '',
    '1. e4 { [%clk 0:03:00] } e5 2. Nf3 Nc6 3. Bb5 a6 1-0'
  ].join('\n');

  // A validated game commits once; the record is archive-ready.
  const first = await page.evaluate(function (text) {
    const g = ChessyPGN.parseGame(text);
    if (!g.valid) return { error: g.error };
    const rec = ChessyPGN.toRecord(g, { playerColor: 'w', importedAt: 123 });
    return CoachStore.importGame(rec).then(function (outcome) {
      return CoachStore.getGame(rec.id).then(function (stored) {
        return { outcome: outcome, id: rec.id, plies: stored && stored.plies,
          firstUci: stored && stored.moves[0].uci, source: stored && stored.source,
          setupFen: stored && stored.setupFen, clk: stored && stored.clocks[0] };
      });
    });
  }, pgn);
  check(first.outcome === 'imported' && first.plies === 6 && first.firstUci === 'e2e4' &&
    first.source === 'import' && first.clk && first.clk.ms === 180000,
    'a valid PGN imports once with canonical moves and clocks');
  check(await importCount() === 1, 'one imported game after the first import');

  // Re-importing the SAME PGN dedupes to one game (content-hash id).
  const dup = await page.evaluate(function (text) {
    const rec = ChessyPGN.toRecord(ChessyPGN.parseGame(text), { playerColor: 'w' });
    return CoachStore.importGame(rec);
  }, pgn);
  check(dup === 'duplicate', 're-importing the same game reports "duplicate"');
  check(await importCount() === 1, 'a repeated import still yields exactly one game');

  // An INVALID PGN writes nothing — the caller checks .valid before importing.
  const bad = await page.evaluate(function () {
    const g = ChessyPGN.parseGame('[Result "*"]\n\n1. e4 e5 2. Kzz *');
    if (g.valid) { // must NOT happen
      return CoachStore.importGame(ChessyPGN.toRecord(g, {})).then(function () { return 'wrote'; });
    }
    return 'rejected:' + g.ply;
  });
  check(bad === 'rejected:3', 'an illegal move is rejected before any write');
  check(await importCount() === 1, 'a rejected import adds no game');

  // Dedupe can also key on an external id: a different move order under the
  // SAME external id is still one game (incremental re-sync safety).
  const ext = await page.evaluate(function () {
    const a = ChessyPGN.toRecord(ChessyPGN.parseGame('1. d4 d5 *'),
      { externalId: 'src:xyz', playerColor: 'b' });
    const b = ChessyPGN.toRecord(ChessyPGN.parseGame('1. c4 c5 *'),
      { externalId: 'src:xyz', playerColor: 'b' });
    return CoachStore.importGame(a).then(function (o1) {
      return CoachStore.importGame(b).then(function (o2) {
        return { o1: o1, o2: o2 };
      });
    });
  });
  check(ext.o1 === 'imported' && ext.o2 === 'duplicate',
    'a shared external id dedupes regardless of move content');
  check(await importCount() === 2, 'external-id dedupe leaves two imported games total');
});
