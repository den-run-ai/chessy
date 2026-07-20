/* Manual reflection: flag one position → answer before the engine speaks
 * → ONE bounded probe → player-owned cause → one card per moment. */
'use strict';
require('./helper').run('reflection', async function (t) {
  const page = t.page, check = t.check, mv = t.mv;

  async function cards() {
    return page.evaluate(function () { return CoachStore.listCards(); });
  }
  async function verifyDone() {
    await page.waitForFunction(function () {
      const el = document.getElementById('verifyResult');
      return el.textContent && el.textContent.indexOf('Analysing') === -1;
    }, null, { timeout: 60000 });
  }

  // Archive a fool's mate and open it in Review.
  await t.newGame({ mode: 'pvp' });
  await mv('f2', 'f3'); await mv('e7', 'e5');
  await mv('g2', 'g4'); await mv('d8', 'h4');
  await page.waitForSelector('#gameOverDialog[open]');
  await page.click('#gameOverReview');
  await page.waitForSelector('#viewReview:not([hidden])');
  await page.waitForFunction(function () {
    return document.getElementById('reviewStatus').textContent.indexOf('Position 0/') !== -1;
  });

  // The end position has no played move to flag.
  await page.click('#revEnd');
  check(await page.locator('#flagMoment').isDisabled(), 'cannot flag the end position');
  await page.click('#revPrev'); // ply 3: Qh4# was played here

  // Reflection gates the engine.
  await page.click('#flagMoment');
  check(await page.locator('#reflectForm').isVisible(), 'reflection form opens on flag');
  check(await page.locator('#verifyBox').isHidden(), 'engine output hidden until reflection submitted');
  await page.click('#reflectVerify'); // EMPTY reflection: required fields block
  check(await page.locator('#verifyBox').isHidden(),
    'empty reflection cannot summon the engine (fields are required)');
  await page.fill('#reflectThreat', '   ');
  await page.fill('#reflectCandidates', '  ');
  await page.selectOption('#reflectEval', 'winning');
  await page.click('#reflectVerify');
  check(await page.locator('#verifyBox').isHidden(),
    'whitespace-only reflection is rejected (trimmed before validation)');

  // One probe; the played mate IS Chessy's move.
  await page.fill('#reflectThreat', 'mate on h4');
  await page.fill('#reflectCandidates', 'Qh4');
  await page.click('#reflectVerify');
  check(await page.locator('#reflectVerify').isDisabled(), 'one probe at a time');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('agrees'),
    'matching move reported as agreement');
  check(await page.locator('#causeLabel').isHidden(),
    'no cause asked when the move matches');
  check(!(await page.locator('#reflectVerify').isDisabled()), 'probe button re-enables');

  // Lesson required; the reflection snapshot survives a post-verdict edit.
  await page.click('#saveCard');
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('lesson'),
    'saving requires a one-sentence lesson');
  await page.fill('#reflectThreat', 'rewritten after seeing the verdict');
  await page.fill('#cardLesson', 'Look for forcing mates first');
  await page.evaluate(function () {
    document.getElementById('saveCard').click();
    document.getElementById('saveCard').click();
  });
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('Lesson card saved') !== -1;
  });
  const saved = await cards();
  check(saved.length === 1, 'double-clicking Save creates exactly one card');
  check(saved[0].kind === 'match' && saved[0].cause === 'match' &&
        saved[0].step === -1 && saved[0].due <= Date.now() &&
        saved[0].reflection.threat === 'mate on h4' && !!saved[0].bestMove,
    'card stores the PRE-verdict reflection snapshot, verdict and immediate due');

  // Re-saving the SAME moment updates its one card — no duplicates.
  await page.fill('#reflectThreat', 'mate on h4, second look');
  await page.fill('#reflectCandidates', 'Qh4');
  await page.selectOption('#reflectEval', 'winning');
  await page.click('#reflectVerify');
  await verifyDone();
  await page.fill('#cardLesson', 'Revised: forcing mates first, always');
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('Updated') !== -1;
  });
  const resaved = await cards();
  check(resaved.length === 1 && resaved[0].lesson === 'Revised: forcing mates first, always' &&
        resaved[0].reflection.threat === 'mate on h4, second look',
    're-saving the same moment updates its one card');

  // A DIFFERING move: the player owns the call, including "also sound".
  await page.click('#revStart'); // ply 0: f3 was played here
  check(await page.locator('#reflectForm').isHidden(),
    'stepping away abandons the unsaved reflection');
  await page.click('#flagMoment');
  check(await page.evaluate(function () { return document.getElementById('reflectEval').value; }) === '',
    'flagging a new moment clears the previous answers');
  await page.fill('#reflectThreat', 'nothing concrete');
  await page.fill('#reflectCandidates', 'e4, d4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check((await page.textContent('#verifyResult')).includes('preferred') &&
        (await page.textContent('#verifyResult')).includes('not necessarily an error'),
    'a differing move is not declared an error');
  check(!(await page.locator('#causeLabel').isHidden()), 'cause picker shown for a differing move');
  await page.fill('#cardLesson', 'Do not weaken the king for nothing');
  await page.click('#saveCard');
  await page.waitForSelector('#cardSaved:not([hidden])');
  check((await page.textContent('#cardSaved')).includes('cause'),
    'differing moves require the player’s cause call');
  await page.selectOption('#cardCause', 'sound-alternative');
  await page.click('#saveCard');
  await page.waitForFunction(function () {
    return document.getElementById('cardSaved').textContent.indexOf('Lesson card saved') !== -1;
  });
  const both = await cards();
  check(both.length === 2 && both.some(function (c) { return c.cause === 'sound-alternative'; }),
    '"my move was also sound" is a first-class cause (2 cards total)');

  // Abandoning a probe: leave the game while it runs — the verdict must
  // not land, and Save must stay disabled for the next moment.
  await page.click('#flagMoment'); // re-flag ply 0
  await page.fill('#reflectThreat', 'x');
  await page.fill('#reflectCandidates', 'y');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await page.click('#reviewBack'); // abandon mid-probe
  await page.waitForTimeout(2500);
  await page.locator('.game-item').first().click();
  await page.click('#flagMoment'); // fresh moment, ply 0
  check(await page.locator('#verifyBox').isHidden(),
    'an abandoned probe repaints nothing on the freshly flagged moment');
  await page.fill('#reflectThreat', 'still nothing');
  await page.fill('#reflectCandidates', 'e4');
  await page.selectOption('#reflectEval', 'equal');
  await page.click('#reflectVerify');
  await verifyDone();
  check(!(await page.locator('#saveCard').isDisabled()),
    'a fresh probe after the abandoned one works normally');
});
