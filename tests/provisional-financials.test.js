const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const AdmZip=require('adm-zip');
const {parseProvisionalFinancials,readDisclosureXml,amount}=require('../provisionalFinancials');
const samsung=fs.readFileSync(path.join(__dirname,'fixtures/provisional-samsung.html'),'utf8');
const netmarble=fs.readFileSync(path.join(__dirname,'fixtures/provisional-netmarble.html'),'utf8');

test('Samsung merged headers select quarter amounts, excluding percentages and cumulative rows',()=>{
 const result=parseProvisionalFinancials(samsung);
 assert.equal(result.unit,'조원');assert.deepEqual(result.labels,{current:'26.3Q',previous:'26.2Q',yearAgo:'25.3Q'});
 assert.deepEqual(result.metrics,[{name:'매출액',current:195.25,previous:171.5,yearAgo:86.06},{name:'영업이익',current:107.44,previous:89.49,yearAgo:12.17}]);
});
test('different companies retain their own unit, period labels and missing values',()=>{
 const result=parseProvisionalFinancials(netmarble.replace('<td>2,039</td>','<td>-</td>'));
 assert.equal(result.unit,'억원');assert.equal(result.labels.current,"'26년3분기");
 assert.deepEqual(result.metrics[2],{name:'당기순이익',current:222,previous:null,yearAgo:406});
});
test('financial losses and zero remain numeric; blanks, percentages and malformed numbers do not',()=>{
 for(const [input,expected] of [['△1,234',-1234],['(12.5)',-12.5],['−2',-2],['0',0],['-',null],['12%',null],['흑자전환',null],['1,23',null]])assert.equal(amount(input),expected,input);
});
test('unsupported units, monthly sales blanks, and cumulative-only tables never fabricate chart data',()=>{
 assert.equal(parseProvisionalFinancials(samsung.replace('단위 : 조원, %','단위 미표기')),null);
 assert.equal(parseProvisionalFinancials(samsung.replace(/195\.25|171\.50|86\.06|107\.44|89\.49|12\.17/g,'-')),null);
 assert.equal(parseProvisionalFinancials(samsung.replace(/당해실적/g,'누계실적')),null);
});
test('uppercase XML and a simple unmerged header are supported',()=>{
 const xml='<TABLE><TR><TD>단위:백만원</TD></TR><TR><TD>구분</TD><TD>당기실적</TD><TD>전기실적</TD><TD>전년동기실적</TD></TR><TR><TD>영업이익(손실)</TD><TD>(10)</TD><TD>0</TD><TD>20</TD></TR></TABLE>';
 assert.deepEqual(parseProvisionalFinancials(xml).metrics,[{name:'영업이익',current:-10,previous:0,yearAgo:20}]);
});
test('ZIP reader favors valid UTF-8 bytes over a stale HTML meta charset and rejects oversized XML',()=>{
 const zip=new AdmZip();zip.addFile('main.xml',Buffer.from('<html><head><meta charset="euc-kr"></head><body>'+samsung+'</body></html>'));
 assert.equal(parseProvisionalFinancials(readDisclosureXml(zip.toBuffer())).metrics[0].current,195.25);
 const large=new AdmZip();large.addFile('large.xml',Buffer.alloc(8*1024*1024+1));assert.throws(()=>readDisclosureXml(large.toBuffer()));
});
