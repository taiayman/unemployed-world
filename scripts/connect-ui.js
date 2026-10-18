import { readFileSync } from 'node:fs';
import { atomicWrite, assert } from '../src/util.js';

const source = process.argv[2];
assert(source, 'Usage: npm run ui -- "path/to/unemployed.world.html"');
let html = readFileSync(source, 'utf8');
assert(html.includes('/* live drift (sample) */') && html.includes('const JOBS = ['), 'Expected the supplied unemployed.world preview HTML');
const replace = (from, to) => { assert(html.includes(from), `UI anchor missing: ${from.slice(0, 60)}`); html = html.replace(from, to); };

replace('(function(){', '(async function(){');
html = html.replace(/const JOBS = \[[\s\S]*?\n\];/, `
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let payload;
try {
  const response = await fetch('./jobs.json', {cache:'no-cache'});
  if(!response.ok) throw new Error('HTTP '+response.status);
  payload = await response.json();
  if(payload.schemaVersion!==1 || !Array.isArray(payload.jobs)) throw new Error('Unsupported data format');
} catch(error) {
  document.getElementById('hint').textContent='Live data unavailable. Try again later.';
  document.querySelector('.sample').textContent='DATA UNAVAILABLE';
  return;
}
const JOBS = payload.jobs;
document.querySelector('.sample').textContent='UPDATED '+payload.generatedAt.slice(0,16).replace('T',' ')+' UTC';
const ageHours=(Date.now()-Date.parse(payload.generatedAt))/3600000;
if(ageHours>48) document.querySelector('.sample').textContent+=' · STALE DATA';
const footer=document.querySelector('footer .wrap');
footer.innerHTML='<span>Bounded public-source samples. Risk is observed AI exposure, not a job-loss probability.</span><span><a href="./jobs.json" style="color:inherit">Data, sources and methodology</a> · O*NET® / USDOL · Anthropic</span>';
if(!JOBS.length) {
  document.getElementById('hint').textContent='Collecting postings. Occupations appear after O*NET matching is enabled.';
  document.getElementById('pass').textContent='No measured occupations yet. No sample figures are shown.';
  document.getElementById('marq').textContent=(payload.news||[]).slice(0,8).map(n=>n.title).join(' · ');
  return;
}
const UNKNOWN={key:'UNKNOWN',label:'COLLECTING',meaning:'90-day comparison unavailable',color:'var(--muted)'};
`);
replace('function status(chg){', 'function status(chg){\n  if(chg==null) return UNKNOWN;');
replace('const fmtChg = c => ((c>0?"+":"")+c+"%");', 'const fmtChg = c => c==null ? "--" : ((c>0?"+":"")+c+"%");');
replace('String(job.ai).padStart(col.n," ")', '(job.ai==null?"--":String(job.ai)).padStart(col.n," ")');
replace("STATUS.slice().reverse().forEach(s=>{", "[...STATUS.slice().reverse(),UNKNOWN].forEach(s=>{");

// Replace synthetic series and causal sample events with observations and citations.
const chart = `function chart(job, st){
  const points=job.history||[], valid=points.filter(p=>Number.isFinite(p.count));
  if(valid.length<2) return '<p>Collecting daily observations. Gaps and missing history are not filled in.</p>';
  const W=640,H=190,L=44,R=24,T=16,B=28, hi=Math.max(1,...valid.map(p=>p.count));
  const x=i=>L+(W-L-R)*i/Math.max(1,points.length-1), y=v=>T+(H-T-B)*(1-v/hi);
  const lines=[]; let segment=[];
  points.forEach((p,i)=>{if(Number.isFinite(p.count)) segment.push(x(i).toFixed(1)+','+y(p.count).toFixed(1)); else if(segment.length){lines.push(segment);segment=[];}});
  if(segment.length) lines.push(segment);
  return '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Daily unique observed postings; gaps are missing data">'+
    '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="#cfc8b6"/>'+
    lines.map(seg=>'<polyline points="'+seg.join(' ')+'" fill="none" stroke="#16181d" stroke-width="2.5"/>').join('')+
    '<text x="8" y="20" font-size="12">'+hi+'</text><text x="8" y="'+y(0)+'" font-size="12">0</text>'+
    '<text x="'+L+'" y="'+(H-6)+'" font-size="11">'+esc(points[0].date)+'</text>'+
    '<text x="'+(W-R)+'" y="'+(H-6)+'" text-anchor="end" font-size="11">'+esc(points[points.length-1].date)+'</text></svg>';
}
function events(job){
  const out=[['SAMPLE',job.activeSample+' unique postings seen in the last 7 days'],['COVERAGE',Math.round(job.exposure.taskCoverage*100)+'% of O*NET tasks matched to exposure evidence']];
  for(const evidence of job.exposure.evidence||[]) out.push(['EVIDENCE',evidence.attribution||evidence.definition||evidence.version]);
  out.push(['CAUTION','News and sentiment do not establish why hiring changed.']);
  return out;
}
`;
html = html.replace(/function seeded\(str\)[\s\S]*?(?=function riskWord)/, chart);
replace('function riskWord(a){ return', 'function riskWord(a){ if(a==null) return "Unknown"; return');
replace("+job.code+'</div><h2", "+esc(job.code)+'</div><h2");
replace("+job.name+'</h2>", "+esc(job.name)+'</h2>");
replace("+job.ai+'<span", "+(job.ai??'--')+'<span");
replace("+job.ai+'%", "+(job.ai??0)+'%");
replace('Job postings index · sample', 'Daily observed postings · gaps are missing data');
replace('What moved it · sample', 'Evidence and coverage');
replace("e[0]+'</b>'+e[1]", "esc(e[0])+'</b>'+esc(e[1])");
replace("shareText(job).replace(/\"/g,'&quot;')", 'esc(shareText(job))');
replace('More jobs arrive when the live feed launches.', 'More occupations appear as postings are classified.');
html = html.replace(/const PA=\[[\s\S]*?\];\n(?=document.getElementById\('marq'\))/, `const PA=['Daily public API samples. A status is not proof of AI-caused job losses.',...(payload.news||[]).slice(0,10).map(n=>n.title)];\n`);
html = html.replace(/\/\* live drift \(sample\) \*\/[\s\S]*?(?=\/\* boot \*\/)/, '');
replace('setInterval(drift, 4500);', '// Daily export only; no fabricated live drift.');
replace("Demand = change in job postings over 90 days · Risk = share of the job's tasks AI tools can already do", 'Demand = sampled postings change over 90 days · Risk = observed AI exposure, not replacement probability');
replace('Which jobs are taking off, and which ones AI is cancelling', 'Job demand and observed AI exposure, updated daily');
replace('PREVIEW · SAMPLE DATA', 'LOADING DAILY DATA');
replace('Preview build. All figures on this page are sample data until the live feed launches.', 'Loading daily public-source observations.');
replace('Planned sources: public job board APIs, O*NET task data, AI lab release notes.', 'Sources and methodology are included in jobs.json.');
atomicWrite('site/index.html', html);
console.log('Connected site/index.html to jobs.json; original HTML unchanged');
