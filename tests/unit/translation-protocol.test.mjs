import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTranslationAnswer, translationOutputBudget, translationResponseOptions, buildTranslationMessages, providerResponseShape} from '../../src/ai/translation/protocol.mjs';
const one={id:'t1',text:'你好。'}, two={id:'t2',text:'游戏很有趣。'};
for(const [name,text] of [
 ['canonical',JSON.stringify({items:[one,two]})],
 ['Markdown and BOM', '\uFEFF  ```json\r\n'+JSON.stringify({items:[one,two]})+'\r\n```  '],
 ['id array',JSON.stringify([one,two])],
 ['id map',JSON.stringify({t1:one.text,t2:two.text})],
 ['translation array',JSON.stringify({translations:[{id:'t1',translation:one.text},two]})],
 ['JSON string envelope',JSON.stringify(JSON.stringify({items:[one,two]}))]
]) test(`translation safely maps ${name}`,()=>{
 const result=parseTranslationAnswer(text,['t1','t2'],{finishReason:'stop'});
 assert.equal(result.code,null);assert.deepEqual([...result.translations.values()],[one.text,two.text]);
});
test('plain text is valid only for one unambiguous paragraph',()=>{
 assert.equal(parseTranslationAnswer('  你好。\n',['t1']).translations.get('t1'),'你好。');
 assert.equal(parseTranslationAnswer('你好。',['t1','t2']).translations.size,0);
});
test('duplicate ids are ambiguous and never silently overwrite a translation',()=>{
 const r=parseTranslationAnswer(JSON.stringify({items:[one,two,{id:'t1',text:'另一个'}]}),['t1','t2']);
 assert.equal(r.code,'TRANSLATION_ID_MISMATCH');assert.equal(r.translations.has('t1'),false);assert.equal(r.translations.get('t2'),two.text);
});
test('unknown ids do not discard safely identified results',()=>{
 const r=parseTranslationAnswer(JSON.stringify({items:[one,{id:'secret-untrusted-value',text:'x'}]}),['t1','t2']);
 assert.equal(r.translations.get('t1'),one.text);assert.equal(r.code,'TRANSLATION_ID_MISMATCH');assert.doesNotMatch(JSON.stringify(r.diagnostics),/secret-untrusted/);
});
test('truncation recovers only fully closed items, without inventing text or closing quotes',()=>{
 const raw='{"items":['+JSON.stringify(one)+',{"id":"t2","text":"未完成';
 const r=parseTranslationAnswer(raw,['t1','t2'],{finishReason:'length',reasoningChars:120});
 assert.equal(r.code,'TRANSLATION_OUTPUT_TRUNCATED');assert.equal(r.translations.size,1);assert.equal(r.translations.get('t1'),one.text);assert.equal(r.diagnostics.reasoningChars,120);
 assert.equal(parseTranslationAnswer('{"items":[{"id":"t1","text":"未完成',['t1'],{finishReason:'length'}).translations.size,0);
});
test('a malformed envelope can still preserve independently complete entries locally',()=>{
 const r=parseTranslationAnswer('{"items":['+JSON.stringify(one)+', BAD',['t1','t2']);
 assert.equal(r.code,'TRANSLATION_INVALID_JSON');assert.equal(r.translations.size,1);
});
test('missing values, non-text fields and excessive text are not cached as translations',()=>{
 for(const text of [null,42,{},' ', 'x'.repeat(8001)]){
 const r=parseTranslationAnswer(JSON.stringify({items:[{id:'t1',text}]}),['t1']);assert.equal(r.translations.size,0);assert.ok(r.code);
 }
});
test('empty final content and a wrong JSON structure have distinct classifications',()=>{
 assert.equal(parseTranslationAnswer(' ',['t1']).code,'TRANSLATION_EMPTY_CONTENT');
 assert.equal(parseTranslationAnswer('{"wrong":[]}', ['t1']).code,'TRANSLATION_RESPONSE_SHAPE');
});
test('budget includes escaping, paragraph-id overhead and expansion instead of source chars / 2',()=>{
 const items=Array.from({length:40},(_,i)=>({text:'日本語の短い要約。'.repeat(i%3+1)}));
 assert.ok(translationOutputBudget(items)>1200);assert.ok(translationOutputBudget(items)<=12000);
 const messages=buildTranslationMessages(items,'zh-CN');assert.match(messages[0].content,/response itself is JSON/);assert.doesNotMatch(messages[0].content,/Output plain text only/);
});
test('provider-specific output hints remain portable and never require json_schema',()=>{
 for(const providerId of ['openai','deepseek','minimax','dashscope','openrouter','opencode'])assert.equal(translationResponseOptions({providerId}).responseFormat,'json_object');
 assert.equal(translationResponseOptions({providerId:'anthropic',protocol:'anthropic'}).responseFormat,'none');
 assert.equal(translationResponseOptions({providerId:'custom'}).responseFormat,'none');
 assert.equal(translationResponseOptions({providerId:'custom',capabilities:{json:true}}).responseFormat,'json_object');
});
test('diagnostic metadata never includes final or reasoning text',()=>{
 const safe=providerResponseShape({choices:[{message:{content:'PRIVATE REPORT',reasoning_content:'PRIVATE THOUGHT'}}]});
 assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);assert.equal(safe.finalContentChars,14);
 assert.equal(providerResponseShape({choices:[{message:{reasoning_content:'x'}}]}).contentField,false);
});

test('an interrupted Markdown JSON reply still recovers only its closed entries',()=>{
 const text='```json\n{"items":['+JSON.stringify(one)+',{"id":"t2","text":"未完成';
 const r=parseTranslationAnswer(text,['t1','t2'],{finishReason:'length'});
 assert.equal(r.translations.get('t1'),one.text);assert.equal(r.translations.has('t2'),false);
 assert.equal(parseTranslationAnswer(JSON.stringify('{"items":['),['t1']).translations.size,0);
});

test('an explicit negative JSON capability keeps the translation prompt portable',()=>{
 assert.equal(translationResponseOptions({providerId:'openrouter',capabilities:{json:false}}).responseFormat,'none');
});
