const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');
const compact = value => String(value || '').replace(/\s+/g,'');

function readDisclosureXml(zipBuffer) {
  if(zipBuffer.length>10*1024*1024) throw new Error('DISCLOSURE_TOO_LARGE');
  const entries = new AdmZip(zipBuffer).getEntries().filter(entry=>/\.xml$/i.test(entry.entryName));
  entries.sort((a,b)=>b.header.size-a.header.size);
  if(!entries.length || entries[0].header.size>8*1024*1024) throw new Error('DISCLOSURE_FORMAT_UNSUPPORTED');
  const bytes = entries[0].getData();
  const encoding = bytes.subarray(0,200).toString('ascii').match(/encoding=["']([\w-]+)["']/i)?.[1];
  if(encoding) return new TextDecoder(encoding).decode(bytes);
  // Exchange HTML can retain an old euc-kr meta tag despite containing UTF-8 bytes.
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { return new TextDecoder('euc-kr').decode(bytes); }
}

function amount(text) {
  const value = compact(text).replace(/[−–]/g,'-');
  const match = value.match(/^([+\-△▲]?)(\()?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(\))?$/);
  if(!match || Boolean(match[2])!==Boolean(match[4])) return null;
  const result = Number(match[3].replace(/,/g,''))*((match[1] && match[1]!=='+') || match[2] ? -1 : 1);
  return Number.isFinite(result) ? result : null;
}

function tableGrid(table) {
  const grid=[];
  const name=node=>node.nodeName.toLowerCase();
  const rows=Array.from(table.getElementsByTagName('*')).filter(node=>{
    if(name(node)!=='tr') return false;
    let parent=node.parentNode;
    while(parent && name(parent)!=='table') parent=parent.parentNode;
    return parent===table;
  });
  if(rows.length>1000) return [];
  for(let index=0;index<rows.length;index++) {
    grid[index] ||= [];
    let column=0;
    for(const cell of Array.from(rows[index].childNodes).filter(node=>node.nodeType===1 && ['td','th','te','tu'].includes(name(node)))) {
      while(grid[index][column]!==undefined) column++;
      const span=Number(cell.getAttribute('colspan') || cell.getAttribute('COLSPAN') || 1);
      const height=Number(cell.getAttribute('rowspan') || cell.getAttribute('ROWSPAN') || 1);
      if(!Number.isInteger(span)||span<1||span>32||!Number.isInteger(height)||height<1||height>128||column+span>32) return [];
      const text=compact(cell.textContent);
      for(let y=index;y<index+height;y++) {
        grid[y] ||= [];
        for(let x=column;x<column+span;x++) grid[y][x]=text;
      }
      column+=span;
    }
  }
  return grid;
}

function parseProvisionalFinancials(xml) {
  const doc=new DOMParser({errorHandler:{warning(){},error(){},fatalError(){throw new Error('DISCLOSURE_XML_INVALID');}}}).parseFromString(xml,'text/html');
  const candidates=[];
  for(const table of Array.from(doc.getElementsByTagName('*')).filter(node=>node.nodeName.toLowerCase()==='table')) {
    const unit=compact(table.textContent).match(/단위[:：]?(조원|억원|백만원|천원|원)/)?.[1];
    if(!unit) continue;
    const grid=tableGrid(table);
    const index=grid.findIndex(row=>row.some(cell=>cell==='구분') && row.some(cell=>/^(당기|당해)(실적)?(?:\(|$)/.test(cell)) && row.some(cell=>/^전(?:기|년동기)(실적)?(?:\(|$)/.test(cell)));
    if(index<0) continue;
    const header=grid[index];
    const patterns={current:/^(당기|당해)(실적)?(?:\(|$)/,previous:/^전기(실적)?(?:\(|$)/,yearAgo:/^전년동기(실적)?(?:\(|$)/};
    const columns={},labels={};
    let ambiguous=false;
    for(const [key,pattern] of Object.entries(patterns)) {
      const matches=header.map((cell,i)=>pattern.test(cell)?i:-1).filter(i=>i>=0);
      if(matches.length>1) ambiguous=true;
      columns[key]=matches[0] ?? -1;
      const column=columns[key];
      const inline=column<0 ? '' : header[column].replace(pattern,'').replace(/^\(|\)$/g,'');
      const below=grid[index+1]?.[column] || '';
      labels[key]=inline || (/\d.*(?:Q|분기|년|월|[.\-/]\d)/i.test(below) && amount(below)===null ? below.replace(/^\(|\)$/g,'').slice(0,80) : '');
    }
    if(ambiguous) continue;
    const metrics=new Map();
    for(const row of grid.slice(index+1)) {
      const prefix=row.slice(0,columns.current);
      if(prefix.some(cell=>/누계|누적/.test(cell))) continue;
      const rawName=prefix.find(cell=>/^(매출액|영업수익|영업이익(?:\(손실\))?|당기순이익(?:\(손실\))?)$/.test(cell));
      if(!rawName) continue;
      const name=rawName.replace('(손실)','');
      const values=Object.fromEntries(Object.entries(columns).map(([key,column])=>[key,column<0?null:amount(row[column])]));
      if(values.current!==null && !metrics.has(name)) metrics.set(name,{name,...values});
    }
    const ordered=['매출액','영업수익','영업이익','당기순이익'].map(name=>metrics.get(name)).filter(Boolean).slice(0,3);
    if(ordered.length) candidates.push({chartData:{unit,labels,metrics:ordered},connected:/연결실적내용/.test(compact(table.textContent))});
  }
  candidates.sort((a,b)=>Number(b.connected)-Number(a.connected));
  return candidates[0]?.chartData || null;
}

module.exports = {readDisclosureXml,parseProvisionalFinancials,amount};
