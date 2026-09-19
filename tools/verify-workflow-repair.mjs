import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { checkSource } = require('../hooks/vendor/workflow-static.cjs')
const { main: preflight } = require('../hooks/workflow-preflight.cjs')
const { classifyScriptFailure } = require('../hooks/script-recovery.cjs')
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let count = 0
const check = (condition, message) => { assert.ok(condition, message); count++ }
const bad = "export const meta={}; await agent('implement'); if(args.verify) await agent(`${a.repo}`);"
check(checkSource(bad).some(x => x.includes('undefined variable: a')), 'unexecuted branch catches a before Implement')
check(checkSource("export const meta={}; {const a=args} return a.repo").length > 0, 'block-local alias must not leak')
check(checkSource("export const meta={}; const a=args||{}; return `${a.repo}`").length === 0, 'valid alias accepted')
check(checkSource('export const meta={}; const f=(a)=>a.repo; return f(args)').length === 0, 'function parameter scope accepted')
check(preflight({tool_input:{script:bad}}).hookSpecificOutput.permissionDecision === 'deny', 'inline input blocked')
for (const args of ['继续执行 upgrade-y3-production-20260916', null, [], false, 0]) {
  for (const entry of [{name:'openspec-gnx-routed'}, {script:'export const meta={};return args'}]) {
    check(preflight({tool_input:{...entry,args}})?.hookSpecificOutput?.permissionDecision === 'deny', 'invalid args denied before any dispatch')
  }
}
const identity = {changeDir:'openspec/changes/current',task:'离线实现当前任务',milestone:'1.1'}
check(preflight({tool_input:{name:'openspec-gnx-routed',args:{}}})?.hookSpecificOutput?.permissionDecision === 'deny', 'historical OpenSpec defaults denied')
check(preflight({tool_input:{name:'openspec-gnx-routed',args:{...identity,tasksDoc:'openspec/changes/old/tasks.md'}}})?.hookSpecificOutput?.permissionDecision === 'deny', 'different change tasksDoc denied')
check(preflight({tool_input:{name:'openspec-gnx-routed',args:{...identity,tasksDoc:'openspec/changes/current/tasks.md'}}})?.hookSpecificOutput?.permissionDecision !== 'deny', 'matching named OpenSpec allowed')
check(preflight({tool_input:{name:'builtin-research'}})?.hookSpecificOutput?.permissionDecision !== 'deny', 'unrelated named workflow stays compatible')
check(preflight({tool_input:{script:'export const meta={};return args',args:{repo:'D:/x\0bad'}}}).hookSpecificOutput.permissionDecision === 'deny', 'NUL path blocked')
check(preflight({tool_input:{script:'export const meta={};return args',args:{repo:'D:/x',gitnexusRepo:'D:/x'}}}).hookSpecificOutput.permissionDecision === 'deny', 'index name distinct from path')
check(preflight({tool_input:{script:'export const meta={};return args',args:{repo:'D:/x',gitnexusRepo:'repo-x'}}}) === null, 'valid input accepted')
check(classifyScriptFailure({status:'failed',error:'ReferenceError: a is not defined'})?.kind === 'undefined-variable', 'runtime error classified')
check(classifyScriptFailure({status:'completed',result:{status:'green'},error:'ReferenceError: a is not defined'}) === null, 'successful run not retriggered')
check(classifyScriptFailure({status:'failed',logs:['ReferenceError: a is not defined']}) === null, 'quoted logs are not execution evidence')
for (const file of fs.readdirSync(path.join(root,'templates')).filter(x=>x.endsWith('.js'))) check(checkSource(read(`templates/${file}`)).length === 0, `${file} static scope check`)
function value(schema) {
  if (schema.anyOf) return null
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,value(v)]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return 0
  return 'fixture evidence src/a.ts:1'
}
async function templateRun(file, scenario = {}) {
  const calls = []
  let plan, reviewCount = 0, verifyCount = 0, implementCount = 0
  const agent = async (prompt, opts) => {
    calls.push({label:opts.label,prompt,opts})
    const out = value(opts.schema)
    if (opts.phase === 'Recon') {
      if (out.openspec) Object.assign(out.openspec, {milestoneTaskIds:['1.1'],completedTaskIds:[],milestoneEvidence:['tasks.md:1 milestone 1']}, scenario.milestone)
      if (scenario.recon) Object.assign(out, scenario.recon)
      return out
    }
    if (opts.phase === 'Plan' && !plan) {
      plan = {...out, verdict:'implementable',slices:[{id:'S1',title:'fix',files:['src/a.ts'],rationale:'src/a.ts:1'}],whitelist:['src/a.ts'],mustNotTouch:[],testCommands:['node test.cjs'],evidenceDependencies:[],decisionPoints:[]}
      if ('openspecEdits' in plan) plan.slices[0].sourceTaskIds = ['1.1']
      plan.reviewAssessment = {difficulty:'MEDIUM',risk:'LOW',uncertainty:'LOW',validationAdequate:true,evidence:['src/a.ts:1 已核对 caller 与回归测试'],unknowns:[],...scenario.assessment}
      if (scenario.plan) Object.assign(plan, scenario.plan)
      return structuredClone(plan)
    }
    if (opts.label.startsWith('review:plan:')) {
      reviewCount++
      if (scenario.nullReview) return null
      if (reviewCount === 1 && scenario.revise) {
        const revised = structuredClone(plan)
        revised.testCommands.push('node regression.cjs')
        return {verdict:'revise',scope:scenario.complex?'architecture':'slice',requiresArchitect:!!scenario.complex,affectedSliceIds:['S1'],findings:['src/a.ts:1 缺少回归命令'],revisedPlan:scenario.complex?null:revised}
      }
      return {verdict:'approve',scope:'none',requiresArchitect:false,affectedSliceIds:[],findings:[],revisedPlan:null}
    }
    if (opts.label.startsWith('review:proposal:') || opts.label.startsWith('review:synthesis:')) return {...structuredClone(plan),testCommands:[...plan.testCommands,'node regression.cjs']}
    if (opts.label.startsWith('review:challenge:')) return {findings:['src/a.ts:1 方案涵盖失败场景']}
    if (opts.phase === 'Preflight') { out.ready=true; if(out.baseline)out.baseline={...out.baseline,testTotal:1,testPassed:1}; else {out.testTotal=1;out.testPassed=1} return out }
    if (opts.phase === 'Implement') {
      implementCount++
      if (scenario.onImplement) return scenario.onImplement(prompt,opts,out)
      if ((scenario.advisor && (implementCount === 1 || scenario.exhaust)) || (scenario.repairAdvisor && implementCount === 2)) return {...out,done:false,needsAdvisor:true,advisorTier:scenario.tier??'fable',advisorQuestion:scenario.badRequest?'':'两个实现方案如何选择',blockingEvidence:['src/a.ts:1 caller 存在边界冲突']}
      return {...out,done:true,filesChanged:['src/a.ts']}
    }
    if (opts.label.startsWith('implement-advisor:')) {
      if (scenario.throwAdvisor) throw new Error('fixture advisor runtime error')
      return scenario.nullAdvisor?null:{...out,verdict:scenario.advice??'change-approach',reasoning:'src/a.ts:1 已核对',nextStep:'先校验边界再执行',evidence:['src/a.ts:1']}
    }
    if (opts.phase === 'Verify') {
      verifyCount++
      if (scenario.nullVerify) return null
      return {...out,completedTaskIds:['1.1'],milestoneTaskIds:scenario.milestone?.milestoneTaskIds??['1.1'],milestoneEvidence:['tasks.md:1 checked'],status:scenario.red && verifyCount===1?'red':'green',testTotal:1,testPassed:scenario.liar?0:1,testFailed:scenario.liar?1:0,
        ...scenario.verify,
        commands:['node test.cjs',...(scenario.revise?['node regression.cjs']:[]),'git diff --check','git diff --cached --check'].map(command=>({command,exitCode:0,output:'ok'}))}
    }
    if (opts.phase === 'Audit') return scenario.nullAudit?null:{...out,verdict:scenario.auditVerdict??'accept'}
    throw new Error(`unexpected call ${opts.label}`)
  }
  const source=read(`templates/${file}`).replace('export const meta =','const meta =')
  const run=new AsyncFunction('args','agent','phase','log','parallel',source)
  const result=await run({repo:'D:/fixture',gitnexusRepo:'fixture',task:'fix',changeDir:'D:/fixture/openspec/changes/fix',alwaysReview:true,maxRepairRounds:scenario.liar?0:2,...scenario.args},agent,()=>{},()=>{},fns=>Promise.all(fns.map(f=>f())))
  return {result,calls}
}
for (const file of ['gitnexus-routed.js','openspec-incremental.js']) {
  const direct=await templateRun(file,{revise:true})
  check(direct.result.status==='green',`${file}: direct repair completes: ${JSON.stringify(direct.result).slice(0,600)}`)
  check(direct.calls.filter(x=>x.label.startsWith('review:plan:')).length===2,`${file}: changed plan independently reviewed`)
  check(direct.calls.find(x=>x.opts.phase==='Implement').prompt.includes('node regression.cjs'),`${file}: implement receives repaired plan`)
  check(!direct.calls.some(x=>x.opts.phase==='Commit'),`${file}: default no commit`)
  const complex=await templateRun(file,{revise:true,complex:true})
  check(complex.result.status==='green',`${file}: discussion converges`)
  check(complex.calls.some(x=>x.label==='review:challenge:1')&&complex.calls.some(x=>x.label==='review:synthesis:1'),`${file}: challenger and single synthesis run`)
  const red=await templateRun(file,{red:true})
  check(red.result.status==='green'&&red.calls.some(x=>x.label==='repair:1'),`${file}: red -> Repair -> Verify`)
  const liar=await templateRun(file,{liar:true})
  check(liar.result.status==='red',`${file}: green self-report cannot override failed checks`)
  const missing=await templateRun(file,{nullVerify:true})
  check(missing.result.status==='failed'&&!missing.calls.some(x=>x.opts.phase==='Commit'),`${file}: missing Verify fails`)
  const reviewNull=await templateRun(file,{nullReview:true})
  check(reviewNull.result.status==='failed'&&!reviewNull.calls.some(x=>x.opts.phase==='Implement'),`${file}: missing Review cannot implement`)
  const auto=await templateRun(file,{args:{alwaysReview:false,reviewMode:'auto'}})
  check(auto.result.status==='green' && auto.result.review.verdict==='skipped' && auto.result.review.status==='skipped',`${file}: low risk medium difficulty skips explicitly`)
  check(!auto.calls.some(x=>x.label.startsWith('review:')) && auto.calls.some(x=>x.opts.phase==='Verify'),`${file}: skipped review retains Verify`)
  for (const assessment of [{difficulty:'HIGH'},{risk:'MEDIUM'},{uncertainty:'MEDIUM'},{evidence:[]},{validationAdequate:false},{unknowns:['caller 未核实']}]) {
    const hard=await templateRun(file,{args:{alwaysReview:false,reviewTiming:'plan'},assessment})
    check(hard.calls.some(x=>x.label.startsWith('review:plan:')),`${file}: assessment forces review ${JSON.stringify(assessment)}`)
  }
  for (const tier of ['opus','fable']) {
    const advised=await templateRun(file,{advisor:true,tier,args:{alwaysReview:false}})
    check(advised.result.status==='green',`${file}: ${tier} advice returns to implementation`)
    check(advised.calls.find(x=>x.label==='implement-advisor:1').opts.model===tier,`${file}: agent selects ${tier}`)
    check(advised.calls.filter(x=>x.opts.phase==='Implement')[1].prompt.includes('先校验边界再执行'),`${file}: advice passed to next implementation`)
    check(advised.calls.some(x=>x.opts.phase==='Audit'),`${file}: discovered difficulty triggers independent final review`)
  }
  const fixed=await templateRun(file,{advisor:true,tier:'opus',args:{advisorModel:'fable'}})
  check(fixed.calls.find(x=>x.label==='implement-advisor:1').opts.model==='fable',`${file}: explicit tier override wins`)
  const repairAdvice=await templateRun(file,{red:true,repairAdvisor:true,args:{alwaysReview:false}})
  check(repairAdvice.result.status==='green'&&repairAdvice.result.implementationAdvisor.calls===1,`${file}: Repair shares bounded adviser loop`)
  for (const recon of [{riskFlags:{concurrency:true}},{contracts:{publicApi:true}},{uncertainty:{partial:true}}]) {
    const guarded=await templateRun(file,{recon,args:{alwaysReview:false,reviewTiming:'plan'}})
    check(guarded.calls.some(x=>x.label.startsWith('review:plan:')),`${file}: hard risk/uncertainty forces review`)
  }
  for (const args of [{advisorMax:-1},{advisorMax:1.5},{advisorModel:'unknown'},{reviewMode:'never'}]) {
    await assert.rejects(()=>templateRun(file,{args}))
    count++
  }
  for (const scenario of [{nullAdvisor:true},{badRequest:true},{exhaust:true,args:{advisorMax:1}},{advice:'replan'},{advice:'stop-and-ask'}]) {
    const stopped=await templateRun(file,{advisor:true,...scenario})
    check(stopped.result.status!=='green'&&!stopped.calls.some(x=>x.opts.phase==='Verify'),`${file}: advisor failure/replan/budget never falls through`)
    check(stopped.calls.filter(x=>x.label.startsWith('implement-advisor:')).length<=1,`${file}: bounded advisor calls`)
  }
}
// Exercise the actual development templates, not a second implementation of the scheduler.
const slice = (id, file, execution = {}) => ({id,title:`work ${id}`,files:[file],rationale:`${file}:1`,sourceTaskIds:[id],execution:{parallelSafe:true,dependsOn:[],resources:[],contextFiles:[],acceptance:[`deliver ${id}`],...execution}})
const parallelSlices = [slice('S1','src/a.ts'),slice('S2','src/b.ts'),slice('S3','src/c.ts',{dependsOn:['S1','S2']})]
const parallelPlan = {slices:parallelSlices,whitelist:['src/a.ts','src/b.ts','src/c.ts'],evidenceDependencies:[]}
const leafResult = (opts,out,id) => ({...out,done:true,filesChanged:opts.schema.properties.filesChanged.items.type==='object'?[{path:`src/${id==='S1'?'a':id==='S2'?'b':'c'}.ts`,what:'implemented'}]:[`src/${id==='S1'?'a':id==='S2'?'b':'c'}.ts`]})
for (const file of ['gitnexus-routed.js','openspec-incremental.js']) {
  let active=0,peak=0
  const completed=[]
  const run=await templateRun(file,{plan:parallelPlan,onImplement:async(prompt,opts,out)=>{
    const id=opts.label.split(':')[2]
    if(id==='S3')check(completed.includes('S1')&&completed.includes('S2'),`${file}: dependent waits for both predecessors`)
    if(id==='S1')check(!prompt.includes('work S2')&&!prompt.includes('work S3'),`${file}: leaf context excludes other plans`)
    check(opts.disallowedTools.includes('Agent')&&opts.disallowedTools.includes('Workflow')&&opts.disallowedTools.includes('SendMessage'),`${file}: leaf cannot create nested workers`)
    active++;peak=Math.max(peak,active)
    await new Promise(resolve=>setTimeout(resolve,5))
    active--;completed.push(id)
    return leafResult(opts,out,id)
  }})
  check(run.result.status==='green'&&peak===2,`${file}: actual dispatch overlaps within default limit`)
  check(run.calls.filter(c=>c.opts.phase==='Verify').length===1&&run.calls.filter(c=>c.opts.phase==='Preflight').length===1,`${file}: one shared baseline and integrated Verify`)
  check(run.result.impl.execution.outcomes.length===3,`${file}: all slice outcomes retained`)
  check(run.result.impl.execution.waves[1][0]==='S3',`${file}: dependent release recorded`)
  const serial=await templateRun(file,{plan:parallelPlan,args:{maxParallel:1}})
  check(serial.result.status==='green'&&serial.calls.filter(c=>c.opts.phase==='Implement').length===1,`${file}: budget one retains single writer`)
  const overlap=await templateRun(file,{plan:{...parallelPlan,slices:[slice('S1','src/a.ts'),slice('S2','SRC\\a.ts')],whitelist:['src/a.ts']}})
  check(overlap.calls.filter(c=>c.opts.phase==='Implement').length===1,`${file}: Windows aliases serialize`)
  let settled=false
  const missing=await templateRun(file,{plan:parallelPlan,onImplement:async(prompt,opts,out)=>{
    if(opts.label.includes(':S1:'))return null
    await new Promise(resolve=>setTimeout(resolve,5));settled=true
    return leafResult(opts,out,'S2')
  }})
  check(settled&&missing.result.status==='needs-rework'&&!missing.calls.some(c=>c.opts.phase==='Verify'||c.label.includes(':S3:')),`${file}: missing result waits for siblings and blocks downstream`)
  check(missing.result.execution.outcomes.length===2,`${file}: failed wave keeps successful sibling evidence`)
  const escaped=await templateRun(file,{plan:parallelPlan,onImplement:async(prompt,opts,out)=>({...leafResult(opts,out,opts.label.split(':')[2]),filesChanged:['src/outside.ts']})})
  check(escaped.result.status==='needs-rework'&&!escaped.calls.some(c=>c.opts.phase==='Verify'),`${file}: reported out-of-scope write fails closed`)
  const cycle=await templateRun(file,{plan:{...parallelPlan,slices:[slice('S1','src/a.ts',{dependsOn:['S2']}),slice('S2','src/b.ts',{dependsOn:['S1']})],whitelist:['src/a.ts','src/b.ts']}})
  check(cycle.result.status==='blocked'&&!cycle.calls.some(c=>c.opts.phase==='Implement'),`${file}: dependency cycle has no writers`)
  const advisor=await templateRun(file,{plan:parallelPlan,args:{advisorMax:1},onImplement:async(prompt,opts,out)=>opts.label.endsWith(':0')?{...out,done:false,needsAdvisor:true,advisorTier:'fable',advisorQuestion:'核对当前切片边界',blockingEvidence:['src/a.ts:1']}:leafResult(opts,out,opts.label.split(':')[2])})
  check(advisor.result.status==='needs-rework'&&advisor.calls.filter(c=>c.label.startsWith('implement-advisor:')).length===1,`${file}: all leaves share one advisor budget`)
  check(!advisor.calls.some(c=>c.opts.phase==='Verify'||c.label.includes(':S3:')),`${file}: exhausted shared budget stops next wave`)
  const advisorError=await templateRun(file,{plan:parallelPlan,throwAdvisor:true,onImplement:async(prompt,opts,out)=>opts.label.includes(':S1:')?{...out,done:false,needsAdvisor:true,advisorTier:'fable',advisorQuestion:'核对边界',blockingEvidence:['src/a.ts:1']}:leafResult(opts,out,'S2')})
  check(advisorError.result.status==='failed'&&advisorError.result.execution.outcomes.length===2&&!advisorError.calls.some(c=>c.opts.phase==='Verify'),`${file}: advisor exception retains settled sibling results`)
  const keyA=await templateRun(file,{args:{workflowSliceId:'backend'}})
  const keyB=await templateRun(file,{args:{workflowSliceId:'frontend'}})
  check(keyA.result.checkpoint.key!==keyB.result.checkpoint.key,`${file}: same milestone separate workflow identities`)
}
for(const assessment of [{difficulty:'HIGH'},{risk:'MEDIUM'},{validationAdequate:false}]) {
  const ordinary=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},assessment})
  check(!ordinary.calls.some(c=>c.label.startsWith('review:plan:'))&&ordinary.calls.filter(c=>c.opts.phase==='Audit').length===1,'OpenSpec complete milestone has only final Review despite routine complexity')
  check(ordinary.result.milestoneReview.status==='accepted','milestone acceptance is distinct from Verify green')
}
const partialMilestone=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},milestone:{milestoneTaskIds:['1.1','1.2']}})
check(partialMilestone.result.status==='green'&&partialMilestone.result.milestoneReview.status==='pending'&&!partialMilestone.calls.some(c=>c.opts.phase==='Review'||c.opts.phase==='Audit'),'partial milestone verifies without Review')
const repairedPartial=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},milestone:{milestoneTaskIds:['1.1','1.2']},red:true,repairAdvisor:true})
check(repairedPartial.result.status==='green'&&!repairedPartial.calls.some(c=>c.label.startsWith('review:plan:')||c.opts.phase==='Audit'),'local repair/advisor do not trigger incomplete milestone Review')
const lastSlice=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},milestone:{milestoneTaskIds:['1.1','1.2'],completedTaskIds:['1.2']}})
check(lastSlice.result.milestoneReview.status==='accepted'&&lastSlice.calls.filter(c=>c.opts.phase==='Audit').length===1,'last slice triggers exactly one milestone Review')
for(const milestone of [{milestoneTaskIds:[]},{milestoneEvidence:[]},{completedTaskIds:['foreign']}]) {
  const unknown=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},milestone})
  check(unknown.result.milestoneReview.status==='unconfirmed'&&!unknown.calls.some(c=>c.opts.phase==='Audit'),'unknown milestone evidence does not pretend completion')
}
const driftedMilestone=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},verify:{milestoneTaskIds:['1.1','1.2']}})
check(driftedMilestone.result.milestoneReview.status==='unconfirmed','task scope drift prevents false milestone completion')
for(const spec of [{drift:true},{architectureGap:true},{semanticSpecChange:true},{coverage:'partial'}]) {
  const early=await templateRun('openspec-incremental.js',{args:{alwaysReview:false},milestone:spec})
  check(early.calls.some(c=>c.label.startsWith('review:plan:')),'OpenSpec design changes/unknowns still reviewed before writes')
}
const rejected=await templateRun('openspec-incremental.js',{args:{alwaysReview:false,requireCommit:true},auditVerdict:'needs-rework'})
check(rejected.result.status==='needs-rework'&&!rejected.calls.some(c=>c.opts.phase==='Commit'),'milestone Reviewer rejection blocks commit')
const absentAudit=await templateRun('openspec-incremental.js',{args:{alwaysReview:false,requireCommit:true},nullAudit:true})
check(absentAudit.result.status==='failed'&&!absentAudit.calls.some(c=>c.opts.phase==='Commit'),'missing milestone Review fails closed')

async function recoveryRun(stateName) {
  const labels=[]
  const run=new AsyncFunction('args','agent','phase','log',read('templates/recover-verify.js').replace('export const meta =','const meta ='))
  const result=await run({repo:'D:/fixture',gitnexusRepo:'fixture',approvedPlan:{whitelist:['src/a.ts'],testCommands:['node test.cjs']}},async(prompt,opts)=>{
    labels.push(opts.label)
    if(opts.phase==='Recon')return {state:stateName,evidence:['src/a.ts:1'],missing:[]}
    if(opts.phase==='Implement')return {state:'complete',evidence:['src/a.ts:1 repaired'],missing:[]}
    return {status:'green',gitnexus:'verified',evidence:['test output'],commands:['node test.cjs','git diff --check','git diff --cached --check'].map(command=>({command,exitCode:0,output:'ok'}))}
  },()=>{},()=>{})
  return {result,labels}
}
const complete=await recoveryRun('complete')
check(complete.result.status==='green'&&!complete.labels.some(x=>x.includes('repair:')),'completed implementation only verifies')
const partial=await recoveryRun('partial')
check(partial.result.status==='green'&&partial.labels.filter(x=>x.includes('repair:')).length===1,'partial implementation repaired once')
const unknown=await recoveryRun('unknown')
check(unknown.result.status==='blocked'&&unknown.labels.length===1,'unknown state does not mutate')
const policy=read('tools/lib/workflow-policy.cjs')
const gates=Function(`${policy}\nreturn {reviewPlanError,validateWorkflowArgs,verificationFailure,buildImplementationSchedule,workflowCheckpointKey}`)()
const schedule=(slices,extra={})=>gates.buildImplementationSchedule({slices,whitelist:[...new Set(slices.flatMap(s=>s.files))],mustNotTouch:[],evidenceDependencies:[],...extra},{})
check(schedule([slice('S1','src/a.ts',{resources:['build']}),slice('S2','src/b.ts',{resources:['BUILD']})]).mode==='serial','shared mutable resource serializes writers')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts',{contextFiles:['src/a.ts']})]).mode==='serial','read/write conflicts serialize')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts',{contextFiles:['src/contract.ts']})]).mode==='serial','unfingerprinted read dependency prevents parallel execution')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts')],{whitelist:['src/a.ts','src/b.ts','src/unassigned.ts']}).mode==='serial','unassigned work is not silently dropped')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts')],{mustNotTouch:['src']}).mode==='blocked','protected directory blocks child path')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts',{dependsOn:['unknown']})]).mode==='blocked','unknown dependency blocked')
check(schedule([slice('S1','src/a.ts'),slice('S1','src/b.ts')]).mode==='blocked','duplicate identity blocked')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts',{parallelSafe:false})]).mode==='serial','uncertain safety stays serial')
check(schedule([slice('S1','src/a.ts'),slice('S2','src/b.ts.')]).mode==='serial','Windows trailing-dot aliases disable fan-out')
check(gates.workflowCheckpointKey('base',{workflowSliceId:'S1',checkpointKey:'base::slice:S1'})==='base::slice:S1','resume identity suffix idempotent')
for (const input of [{parallelMode:'always'},{maxParallel:0},{maxParallel:2.5},{maxParallel:5},{workflowSliceId:'../wrong'},{reviewTiming:'never'},{checkpointKey:42}]) {
  assert.throws(()=>gates.validateWorkflowArgs(input));count++
  check(preflight({tool_input:{script:'export const meta={};return args',args:input}})?.hookSpecificOutput?.permissionDecision==='deny','invalid scheduling/review args rejected before dispatch')
}
const original={verdict:'implementable',decisionPoints:[],slices:[{id:'S1',files:['src/a.ts'],rationale:'old'}],whitelist:['src/a.ts'],mustNotTouch:['src/protected.ts'],testCommands:[]}
const altered=structuredClone(original)
altered.mustNotTouch=[]
check(!!gates.reviewPlanError(original,altered,{affectedSliceIds:['S1']},{}),'Reviewer cannot remove mustNotTouch')
altered.mustNotTouch=original.mustNotTouch
altered.slices[0].rationale='changed'
check(!!gates.reviewPlanError(original,altered,{affectedSliceIds:[]},{}),'Reviewer cannot change undeclared slices')
altered.slices[0].files=['src/unlisted.ts']
check(!!gates.reviewPlanError(original,altered,{affectedSliceIds:['S1']},{}),'Reviewer cannot bypass whitelist')
assert.throws(()=>gates.validateWorkflowArgs({maxRepairRounds:-1}))
count++
for (const input of [null, undefined, [], '旧任务', false, 0]) {
  assert.throws(()=>gates.validateWorkflowArgs(input), /structured object/)
  count++
}
assert.throws(()=>gates.validateWorkflowArgs({maxReviewRounds:'2'}))
count++
for(const file of ['gitnexus-routed.js','openspec-incremental.js']) {
  const embedded=read(`templates/${file}`).match(/\/\/ workflow-policy:start\n([\s\S]*?)\nvalidateWorkflowArgs\(args\)/)[1]
  check(embedded===policy.trim(),`${file}: shared policy synchronized`)
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wf-script-recovery-'))
try {
  const session='script-'+path.basename(tmp)
  const runs=path.join(tmp,'projects','fixture',session,'workflows')
  fs.mkdirSync(runs,{recursive:true})
  fs.writeFileSync(path.join(runs,'wf_script.json'),JSON.stringify({runId:'wf_script',status:'failed',result:null,error:'ReferenceError: a is not defined',script:'export const meta={};return a.repo',scriptPath:path.join(tmp,'wf.js'),agentCount:2,totalTokens:10}))
  const invoke=active=>execFileSync(process.execPath,[path.join(root,'hooks/harvest-workflow.cjs')],{input:JSON.stringify({cwd:tmp,session_id:session,stop_hook_active:active}),env:{...process.env,ULTRACODE_PROJECTS_DIR:path.join(tmp,'projects')},encoding:'utf8'})
  const first=JSON.parse(invoke(false))
  check(first.decision==='block'&&first.reason.includes('recover-verify'),'Stop resumes outer recovery with evidence')
  check(invoke(false)==='','same terminal does not trigger twice')
  check(invoke(true)==='','Stop recursion blocked')
} finally { fs.rmSync(tmp,{recursive:true,force:true}) }
console.log(`Workflow repair: ${count} checks passed; liveModelCalls=0`)
