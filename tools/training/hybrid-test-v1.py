#!/usr/bin/env python3
"""Once-only authenticated NNUE test for the already frozen smooth-6-12 hybrid."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys
import importlib.util
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('_hybrid_test_screen',ROOT/'tools/training/hybrid-screen-v1b.py')
screen=importlib.util.module_from_spec(spec);sys.modules[spec.name]=screen;spec.loader.exec_module(screen)
util=screen.util;data_io=screen.data_io
CONTRACT=ROOT/'eval/training/hybrid-test-v1.json'
CONTRACT_SHA='4af21daf6ed8015ddfa5ff8cc0636f9e3d997f43a5c56c24d564587f8485eb60'


def validate_frozen(summary,decision,rules):
    """Pure fail-closed semantic checks, in addition to exact-byte receipt pins."""
    if summary.get('schema')!='chessy.hybrid-screen.v1b' or summary.get('testEligible') is not True or summary.get('stopReasons')!=[] or summary.get('testOpened') is not False:
        raise ValueError('test requires eligible unopened screen')
    if summary.get('contractSha256')!=rules['screenContractSha256'] or summary.get('decision')!=decision:
        raise ValueError('screen decision identity differs')
    if decision.get('config')!=rules['config'] or decision.get('finalBinarySha256')!=rules['modelBinarySha256'] or decision.get('selectionUsesOuter') is not False:
        raise ValueError('frozen candidate differs')
    if summary.get('inherited',{}).get('final',{}).get('binary')!=rules['modelBinarySha256']:
        raise ValueError('inherited model differs')
    config=rules['config'];outer=summary.get('outer',{})
    if set(outer.get('models',{}))!={config['id']} or outer.get('numericalStopReasons')!=[]:
        raise ValueError('one outer candidate with passing numerical controls required')
    candidate=outer['models'][config['id']]
    if candidate['config']!=config:raise ValueError('outer config differs')
    comparators=outer.get('comparators',{})
    if not {'shipped-hce','frozen-expanded-hce'}<=set(comparators):raise ValueError('both comparators required')
    for quality in [candidate['quality'],comparators['shipped-hce'],comparators['frozen-expanded-hce']]:
        for group in [quality,*quality['byPhase'].values()]:
            if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in group.values() if not isinstance(v,dict)):
                raise ValueError('nonfinite quality statistic')
        if quality['rows']!=2374:raise ValueError('outer row count differs')
    for name in ('shipped-hce','frozen-expanded-hce'):
        if util.guard(comparators[name],candidate['quality']):raise ValueError('outer quality guard failed')
    checks=candidate['checks']
    if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in checks.values()):raise ValueError('nonfinite numerical check')
    if checks['rows']!=2374 or checks['integerMismatches']!=0 or checks['maximumAbsFloatDifferenceCp']>5 or checks['meanAbsFloatDifferenceCp']>1 or checks['maximumAbsoluteScoreCp']>10000:
        raise ValueError('outer numerical guard failed')


def check_markers(roots):
    markers=[]
    for root in roots:
        root=Path(root)
        if root.resolve()!=root.absolute() or not root.is_dir():raise ValueError('registered state root missing or symlinked')
        markers.extend(root.rglob('test-opened.json'))
    if markers:raise FileExistsError('dataset test was already opened: '+str(markers[0]))


def implementation():
    rules=json.loads(util.read_exact(CONTRACT,CONTRACT_SHA));_,expected,head=screen.implementation()
    paths=[Path(__file__),CONTRACT,ROOT/'tools/training/hybrid-test-selftest-v1.py']
    tracked=set(subprocess.check_output(['git','ls-files'],cwd=ROOT,text=True).splitlines())
    if any(str(p.relative_to(ROOT)) not in tracked for p in paths):raise ValueError('commit test implementation before opening')
    if subprocess.check_output(['git','diff','HEAD','--',*[str(p.relative_to(ROOT)) for p in paths]],cwd=ROOT):raise ValueError('test implementation modified')
    expected.update({p:util.digest(p.read_bytes()) for p in paths})
    return rules,expected,head


def authenticate_frozen(output,rules,expected):
    audit_path=Path(rules['independentAudit']['path'])
    audit_raw=util.read_exact(audit_path,rules['independentAudit']['sha256']);expected[audit_path]=util.digest(audit_raw)
    audit=json.loads(audit_raw)
    if audit.get('status')!='PASS' or audit.get('mismatches')!=0 or audit.get('testEligible') is not True or audit.get('nnueTestFilesReadOrHashed')!=0 or audit.get('selectionSha256')!=rules['screenArtifacts']['selection.json'] or audit.get('contractSha256')!=rules['screenContractSha256']:
        raise ValueError('independent audit must match and pass without test access')
    for name,item in audit['inputs'].items():
        path=Path(name);raw=util.read_exact(path,item['sha256']);expected[path]=item['sha256']
        if len(raw)!=item['bytes']:raise ValueError('independent audit input size differs')
    contents={}
    for name,pin in rules['screenArtifacts'].items():
        path=output/name;contents[name]=util.read_exact(path,pin);expected[path]=pin
    summary=json.loads(contents['selection.json']);decision=json.loads(contents['decision.json'])
    validate_frozen(summary,decision,rules)
    # Source/model/data bytes used by the screen remain bound even though this
    # separately registered test implementation has a later Git commit.
    for name,digest in summary['inputSha256'].items():
        path=Path(name);util.read_exact(path,digest);expected[path]=digest
    state=ROOT/'.research-state'/('hybrid-'+rules['screenContractSha256'])
    for name,pin in rules['screenStateSha256'].items():
        path=state/name;util.read_exact(path,pin);expected[path]=pin
    frozen=json.loads((state/'selection-frozen.json').read_text())
    candidate=json.loads((state/'candidate-frozen.json').read_text())
    if frozen!={'selectionSha256':rules['screenArtifacts']['selection.json'],'testEligible':True} or candidate['decisionSha256']!=rules['screenArtifacts']['decision.json']:
        raise ValueError('persisted selection state differs')
    return summary,json.loads(contents['split-identities.json'])


def receipt_header(marker):
    return {**marker,'schema':'chessy.hybrid-test.v1'}


def run(bundle,checkpoints,output):
    rules,expected,head=implementation()
    roots=[ROOT/'.research-state',*[Path(p) for p in rules['priorStateRoots']]]
    check_markers(roots)
    summary,identities=authenticate_frozen(output,rules,expected)
    auth=data_io.authenticate(bundle);expected.update(auth.expected)
    screen_rules=json.loads(util.read_exact(screen.CONTRACT,screen.CONTRACT_SHA))
    models=screen.authenticate_checkpoints(checkpoints,screen_rules,expected)
    # Restore already authenticated family/source identities without rereading
    # development labels. load_role asserts cross-role isolation against these.
    auth.loaded_identities['shared-train']=identities['shared-train']
    # Authenticate the already exposed outer role solely for lineage isolation.
    # load_role reconstructs frozen shipped parity; no hybrid scoring/selection.
    exposed_outer=data_io.load_role(auth,'nnue-validation')
    if exposed_outer.rows!=2374:raise ValueError('outer lineage coverage differs')
    del exposed_outer
    marker={'schema':'chessy.hybrid-test-opening.v1','head':head,'contractSha256':CONTRACT_SHA,
            'selectionSha256':rules['screenArtifacts']['selection.json'],'decisionSha256':rules['screenArtifacts']['decision.json'],
            'binarySha256':rules['modelBinarySha256'],'summarySha256':screen.shared.SUMMARY_SHA,'role':'nnue-test'}
    registry=screen.shared.test_registry()
    check_markers(roots)
    # reserve_test also performs the unchanged current/legacy marker check and
    # no-replace write. Any error after this line consumes the test opening.
    screen.shared.reserve_test(marker,expected)
    expected[registry]=util.digest(registry.read_bytes())
    test=data_io.load_role(auth,'nnue-test')
    if test.rows!=2331:raise ValueError('test row count differs')
    bases=screen.integer_comparators(util.comparator_predictions(auth,test),test.rows)
    result,predictions,_=screen.evaluate(test,models['final'],bases,[rules['config']],output)
    cp=predictions[rules['config']['id']];quality=result['models'][rules['config']['id']]['quality']
    reasons=list(result['numericalStopReasons']);intervals={}
    for name,base in bases.items():
        reasons += [name+':'+r for r in util.guard(result['comparators'][name],quality)]
        intervals[name]=util.bootstrap(test,base,cp)
        if intervals[name]['ci95'][1]>=0:reasons.append(name+':bootstrap-upper95-not-negative')
    receipt={**receipt_header(marker),'testOpened':True,'offlinePass':not reasons,'stopReasons':reasons,
             'result':result,'bootstrap':intervals,'paidSpendUsd':0,'trainingFits':0,'testRows':test.rows,
             'runtimeIntegrationAllowed':False,'formalPass':False,'inputSha256':{str(p):d for p,d in expected.items()}}
    util.publish(output/'test.json',util.encoded(receipt),expected)
    util.publish(ROOT/'.research-state'/('hybrid-test-'+CONTRACT_SHA)/'test-completed.json',
                 util.encoded({'sha256':util.digest(util.encoded(receipt)),'offlinePass':receipt['offlinePass']}),expected)
    print(json.dumps({'stage':'test-completed','offlinePass':receipt['offlinePass'],'stopReasons':reasons,'testOpened':True}),flush=True)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--checkpoints',type=Path,required=True);p.add_argument('--screen-output',type=Path,required=True)
    a=p.parse_args();run(a.bundle.absolute(),a.checkpoints.absolute(),a.screen_output.absolute())
if __name__=='__main__':main()
