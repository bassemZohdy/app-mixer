import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityRegistry,SqliteDataProvider,registerDataCapability,createRecordJsonSchemaValidator} from '../dist/index.js';

const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{kind:{enum:['person','company']},name:{type:'string',minLength:1},address:{$ref:'#/$defs/address'},employees:{type:'integer',minimum:1}},required:['kind','name','address'],additionalProperties:false,if:{properties:{kind:{const:'company'}},required:['kind']},then:{required:['employees']},$defs:{address:{type:'object',properties:{city:{type:'string',minLength:1},zip:{type:'string',pattern:'^[0-9]{5}$'}},required:['city','zip'],additionalProperties:false}}};
const valid={kind:'company',name:'Acme',address:{city:'Dubai',zip:'12345'},employees:2};

test('draft 2020-12 record schema enforces nested references and conditional rules',()=>{
 const copy=structuredClone(schema),validate=createRecordJsonSchemaValidator(copy);copy.$defs.address.properties.zip.pattern='.*';copy.then.required=[];
 assert.equal(validate(valid),true);assert.equal(validate({...valid,address:{city:'Dubai',zip:'invalid'}}),false);assert.equal(validate({...valid,employees:undefined}),false);const missing={...valid};delete missing.employees;assert.equal(validate(missing),false);assert.equal(validate({...valid,extra:1}),false);assert.equal(validate({...valid,kind:'person',employees:undefined}),false);assert.equal(validate({kind:'person',name:'Ada',address:{city:'Dubai',zip:'12345'}}),true);
});

test('schema registration rejects unsupported, unresolved, async and ambiguous configuration',()=>{
 for(const bad of [null,[],{type:'bogus'},{$ref:'https://example.invalid/schema'},{$async:true,type:'object'},{type:'string',format:'unknown-format'}])assert.throws(()=>createRecordJsonSchemaValidator(bad),/Invalid record JSON Schema/);
 assert.equal(createRecordJsonSchemaValidator(false)({}),false);assert.equal(createRecordJsonSchemaValidator(true)([]),false);
 const provider=new SqliteDataProvider(':memory:'),registry=new CapabilityRegistry(()=>{}),options={candidate:{operationId:'save',method:'PUT',path:'/items'},applicationId:'app',collection:'items',operation:'put',authorize:()=>true,validate:()=>true,jsonSchema:schema};
 try{assert.throws(()=>registerDataCapability(registry,provider,{...options,fields:[{key:'name',label:'Name',type:'string'}]}),/schema/);assert.throws(()=>registerDataCapability(registry,provider,{...options,operation:'get'}),/schema/);}finally{provider.close();}
});

test('schema validation is enforced at the capability boundary before writes for UI and agent',async()=>{
 const provider=new SqliteDataProvider(':memory:'),audit=[],registry=new CapabilityRegistry(e=>audit.push(e.outcome));let calls=0;
 const options={candidate:{operationId:'save',method:'PUT',path:'/items'},applicationId:'app',collection:'items',operation:'put',authorize:()=>true,validate:()=>{calls++;return true;},jsonSchema:structuredClone(schema)};registerDataCapability(registry,provider,options);options.jsonSchema.required=[];
 try{for(const origin of ['ui','agent']){const context={tenantId:'tenant',principalId:origin,origin};await assert.rejects(registry.invoke('save',{id:origin,expectedRevision:null,value:{...valid,address:{city:'Dubai',zip:'bad'}}},context),/Invalid capability input/);assert.equal(provider.get({tenantId:'tenant',applicationId:'app'},'items',origin),undefined);await registry.invoke('save',{id:origin,expectedRevision:null,value:valid},context);assert.deepEqual(provider.get({tenantId:'tenant',applicationId:'app'},'items',origin).value,valid);}assert.equal(calls,2);assert.deepEqual(audit,['attempt','invalid','attempt','succeeded','attempt','invalid','attempt','succeeded']);}finally{provider.close();}
});


test('decimal multiples validate without floating-point quotient errors',()=>{
 for(const [divisor,valid,invalid] of [[0.1,[0,0.3,-0.3,100000000000000000000],[0.31,0.30000000000000004]],[0.01,[4.02,-4.02,1e-2],[4.021,1e-3]],[1e-7,[3e-7,-5e-7],[3.1e-7]],[5e-324,[5e-324,1e-323],[]]]){
  const validate=createRecordJsonSchemaValidator({type:'object',properties:{value:{type:'number',multipleOf:divisor}},required:['value']});for(const value of valid)assert.equal(validate({value}),true,`${value} / ${divisor}`);for(const value of invalid)assert.equal(validate({value}),false,`${value} / ${divisor}`);
 }
 const array=createRecordJsonSchemaValidator({type:'object',properties:{values:{type:'array',items:{type:'number',multipleOf:0.1}}}});assert.equal(array({values:[0.3,-0.3]}),true);assert.equal(array({values:[0.3,0.31]}),false);
 for(const divisor of [0,-1])assert.throws(()=>createRecordJsonSchemaValidator({type:'object',properties:{value:{type:'number',multipleOf:divisor}}}),/Invalid record JSON Schema/);
});
