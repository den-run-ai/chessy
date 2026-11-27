'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const path=require('path');
const cp=require('child_process');
const {sha}=require('./candidate.js');
function tools(rustRoot, binaryenRoot) {
  const binaries = { cargo: path.join(rustRoot, 'bin/cargo'), rustc: path.join(rustRoot, 'bin/rustc'),
    wasmOpt: path.join(binaryenRoot, 'bin/wasm-opt') };
  const versions = Object.fromEntries(Object.entries(binaries).map(([name, file]) =>
    [name, cp.execFileSync(file, name === 'rustc' ? ['--version', '--verbose'] : ['--version']).toString().trim()]));
  assert.match(versions.rustc, /release: 1\.97\.1\n/);
  assert.match(versions.rustc, /commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\n/);
  assert.match(versions.cargo, /^cargo 1\.97\.1 /);
  assert.match(versions.wasmOpt, /^wasm-opt version 131(?: \(version_131\))?$/);
  return { binaries, versions, sha256: Object.fromEntries(Object.entries(binaries).map(([name, file]) => [name, sha(fs.readFileSync(file))])) };
}

function build(directory, selectedTools) {
  for (const mode of ['baseline', 'candidate']) {
    for (let parent = path.join(directory, mode);; parent = path.dirname(parent)) {
      for (const file of ['.cargo/config', '.cargo/config.toml']) {
        assert.equal(fs.existsSync(path.join(parent, file)), false, 'ambient Cargo configuration: ' + parent);
      }
      if (parent === path.dirname(parent)) break;
    }
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C',
      RUSTC: selectedTools.binaries.rustc, CARGO_HOME: path.join(directory, 'cargo-' + mode),
      CARGO_TARGET_DIR: path.join(directory, 'native-target-' + mode),
      CHESSY_CARGO_TARGET_DIR: path.join(directory, 'target-' + mode),
      CHESSY_CARGO_BIN: selectedTools.binaries.cargo, CHESSY_RUSTC_BIN: selectedTools.binaries.rustc,
      CHESSY_WASM_OPT_BIN: selectedTools.binaries.wasmOpt };
    const log = fs.openSync(path.join(directory, mode + '-build.log'), 'wx');
    try {
      const opts = { cwd: path.join(directory, mode), env, stdio: ['ignore', log, log], timeout: 180000 };
      cp.execFileSync(selectedTools.binaries.cargo, ['test', '--locked', '--offline', '--', '--nocapture'], opts);
      cp.execFileSync('sh', ['build.sh'], opts);
    } finally { fs.closeSync(log); }
  }
}


module.exports={tools,build};
if(require.main===module){const [, ,directory,rustRoot,binaryenRoot]=process.argv;if(!directory||!rustRoot||!binaryenRoot)throw Error('usage: build.js OUTPUT RUST_ROOT BINARYEN_ROOT');const selected=tools(path.resolve(rustRoot),path.resolve(binaryenRoot));fs.writeFileSync(path.join(directory,'tools.json'),JSON.stringify(selected,null,2)+'\n',{flag:'wx'});build(path.resolve(directory),selected);}
