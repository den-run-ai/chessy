/*
 * Frozen opening manifest shared by the JavaScript and Rust/WASM match
 * runners. The order is the opening ID used by shard records and clustered
 * statistics; changing any entry requires a new manifest version and digest.
 */
'use strict';

const crypto = require('crypto');
const MatchProtocol = require('./ai-match-protocol');

const OPENINGS = [
  ['Italian', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Two Knights', 'e4 e5 Nf3 Nc6 Bc4 Nf6'],
  ['Two Knights Fried Liver', 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5'],
  ['Ruy Lopez Morphy', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6'],
  ['Ruy Lopez Berlin', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['Ruy Lopez Exchange', 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6'],
  ['Ruy Lopez Steinitz', 'e4 e5 Nf3 Nc6 Bb5 d6'],
  ['Scotch', 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4'],
  ['Scotch Gambit', 'e4 e5 Nf3 Nc6 d4 exd4 Bc4'],
  ['Four Knights', 'e4 e5 Nf3 Nc6 Nc3 Nf6'],
  ['Petrov Classical', 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4'],
  ['Philidor', 'e4 e5 Nf3 d6 d4 exd4 Nxd4 Nf6'],
  ['Vienna Gambit', 'e4 e5 Nc3 Nf6 f4 d5'],
  ['Vienna Bishop', 'e4 e5 Nc3 Nf6 Bc4 Nc6'],
  ['King\'s Gambit Accepted', 'e4 e5 f4 exf4 Nf3 g5'],
  ['King\'s Gambit Declined', 'e4 e5 f4 Bc5'],
  ['Bishop\'s Opening', 'e4 e5 Bc4 Nf6 d3 c6'],
  ['Center Game', 'e4 e5 d4 exd4 Qxd4 Nc6'],
  ['Ponziani', 'e4 e5 Nf3 Nc6 c3 Nf6'],
  ['Sicilian Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Sicilian Dragon', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6'],
  ['Sicilian Scheveningen', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6'],
  ['Sicilian Classical', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6'],
  ['Sicilian Taimanov', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6'],
  ['Sicilian Kan', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6'],
  ['Sicilian Sveshnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5'],
  ['Sicilian Accelerated Dragon', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6'],
  ['Sicilian Rossolimo', 'e4 c5 Nf3 Nc6 Bb5 g6'],
  ['Sicilian Moscow', 'e4 c5 Nf3 d6 Bb5 Bd7'],
  ['Sicilian Alapin', 'e4 c5 c3 Nf6 e5 Nd5'],
  ['Sicilian Alapin d5', 'e4 c5 c3 d5 exd5 Qxd5'],
  ['Sicilian Closed', 'e4 c5 Nc3 Nc6 g3 g6'],
  ['Sicilian Grand Prix', 'e4 c5 Nc3 Nc6 f4 g6'],
  ['Sicilian Smith-Morra', 'e4 c5 d4 cxd4 c3 dxc3 Nxc3'],
  ['Sicilian Kalashnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 e5'],
  ['Sicilian Hyperaccelerated', 'e4 c5 Nf3 g6'],
  ['French Winawer', 'e4 e6 d4 d5 Nc3 Bb4'],
  ['French Classical', 'e4 e6 d4 d5 Nc3 Nf6'],
  ['French Tarrasch', 'e4 e6 d4 d5 Nd2 Nf6'],
  ['French Advance', 'e4 e6 d4 d5 e5 c5'],
  ['French Exchange', 'e4 e6 d4 d5 exd5 exd5'],
  ['French Rubinstein', 'e4 e6 d4 d5 Nc3 dxe4 Nxe4'],
  ['Caro-Kann Classical', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5'],
  ['Caro-Kann Advance', 'e4 c6 d4 d5 e5 Bf5'],
  ['Caro-Kann Exchange', 'e4 c6 d4 d5 exd5 cxd5'],
  ['Caro-Kann Panov', 'e4 c6 d4 d5 exd5 cxd5 c4 Nf6'],
  ['Caro-Kann Two Knights', 'e4 c6 Nc3 d5 Nf3 Bg4'],
  ['Caro-Kann Fantasy', 'e4 c6 d4 d5 f3 e6'],
  ['Scandinavian Main', 'e4 d5 exd5 Qxd5 Nc3 Qa5'],
  ['Scandinavian Modern', 'e4 d5 exd5 Nf6'],
  ['Pirc', 'e4 d6 d4 Nf6 Nc3 g6'],
  ['Pirc Austrian', 'e4 d6 d4 Nf6 Nc3 g6 f4 Bg7'],
  ['Modern Defense', 'e4 g6 d4 Bg7 Nc3 d6'],
  ['Alekhine', 'e4 Nf6 e5 Nd5 d4 d6'],
  ['Alekhine Exchange', 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 exd6'],
  ['Nimzowitsch Defense', 'e4 Nc6 d4 d5'],
  ['Owen Defense', 'e4 b6 d4 Bb7'],
  ['QGD Main', 'd4 d5 c4 e6 Nc3 Nf6'],
  ['QGD Exchange', 'd4 d5 c4 e6 Nc3 Nf6 cxd5 exd5'],
  ['QGD Tartakower', 'd4 d5 c4 e6 Nf3 Nf6 Nc3 Be7'],
  ['Slav', 'd4 d5 c4 c6 Nf3 Nf6'],
  ['Slav Nc3', 'd4 d5 c4 c6 Nc3 Nf6'],
  ['Semi-Slav', 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6'],
  ['QGA', 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6'],
  ['QGA Classical', 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5'],
  ['Tarrasch Defense', 'd4 d5 c4 e6 Nc3 c5'],
  ['Chigorin Defense', 'd4 d5 c4 Nc6'],
  ['Albin Counter-Gambit', 'd4 d5 c4 e5 dxe5 d4'],
  ['Nimzo-Indian', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['Nimzo-Indian Rubinstein', 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O'],
  ['Queen\'s Indian', 'd4 Nf6 c4 e6 Nf3 b6'],
  ['Bogo-Indian', 'd4 Nf6 c4 e6 Nf3 Bb4'],
  ['KID Main', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'],
  ['KID Classical', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O'],
  ['KID Fianchetto', 'd4 Nf6 c4 g6 Nf3 Bg7 g3 O-O'],
  ['Grunfeld', 'd4 Nf6 c4 g6 Nc3 d5'],
  ['Grunfeld Exchange', 'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3'],
  ['Benoni Modern', 'd4 Nf6 c4 c5 d5 e6'],
  ['Benko Gambit', 'd4 Nf6 c4 c5 d5 b5'],
  ['Old Benoni', 'd4 c5 d5 e5'],
  ['Dutch Stonewall', 'd4 f5 g3 Nf6 Bg2 e6'],
  ['Dutch Leningrad', 'd4 f5 g3 Nf6 Bg2 g6'],
  ['Dutch Classical', 'd4 f5 c4 Nf6 Nc3 e6'],
  ['London System', 'd4 d5 Bf4 Nf6 e3 c5'],
  ['London vs KID', 'd4 Nf6 Bf4 g6 e3 Bg7'],
  ['Torre Attack', 'd4 Nf6 Nf3 e6 Bg5 c5'],
  ['Colle System', 'd4 d5 Nf3 Nf6 e3 e6'],
  ['Catalan', 'd4 Nf6 c4 e6 g3 d5 Bg2'],
  ['Catalan Open', 'd4 Nf6 c4 e6 g3 d5 Bg2 dxc4'],
  ['Trompowsky', 'd4 Nf6 Bg5 Ne4'],
  ['Veresov', 'd4 Nf6 Nc3 d5 Bg5'],
  ['English Symmetrical', 'c4 c5 Nc3 Nc6 g3 g6'],
  ['English Four Knights', 'c4 e5 Nc3 Nf6 Nf3 Nc6'],
  ['English Anglo-Indian', 'c4 Nf6 Nc3 e6 Nf3 b6'],
  ['Reti', 'Nf3 d5 c4 e6 g3 Nf6'],
  ['Reti KIA', 'Nf3 d5 g3 Nf6 Bg2 e6'],
  ['King\'s Indian Attack', 'Nf3 Nf6 g3 g6 Bg2 Bg7'],
  ['Bird Opening', 'f4 d5 Nf3 Nf6 e3 g6'],
  ['Larsen Attack', 'b3 e5 Bb2 Nc6'],
  ['Nimzo-Larsen', 'Nf3 Nf6 b3 g6']
];

const manifestHash = crypto.createHash('sha256')
  .update(JSON.stringify(OPENINGS), 'utf8').digest('hex');
if (OPENINGS.length !== MatchProtocol.OPENINGS_MANIFEST_COUNT ||
    manifestHash !== MatchProtocol.OPENINGS_MANIFEST_SHA256) {
  throw new Error('frozen opening list changed without a new manifest version/hash (got ' +
    OPENINGS.length + ' openings, ' + manifestHash + ')');
}

module.exports = Object.freeze(OPENINGS.map(function (opening) {
  return Object.freeze(opening.slice());
}));
