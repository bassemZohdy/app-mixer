/** Inert control-plane counterpart to the generated host-owned record editor. */
export const RECORD_EDITOR_PREVIEW = `

function decimalMultiple(value,divisor){
  const parts=number=>{const [mantissa,exp='0']=number.toString().split('e'),[whole,fraction='']=mantissa.split('.');return [BigInt(whole+fraction),Number(exp)-fraction.length];};
  const [numerator,numeratorExponent]=parts(value),[denominator,denominatorExponent]=parts(divisor),difference=numeratorExponent-denominatorExponent;
  return difference>=0?(numerator*10n**BigInt(difference))%denominator===0n:numerator%(denominator*10n**BigInt(-difference))===0n;
}
function matchesContains(rule,value){
  if(typeof rule.always==='boolean')return rule.always;
  if(rule.allOf&&!rule.allOf.every(child=>matchesContains(child,value)))return false;
  if(rule.anyOf&&!rule.anyOf.some(child=>matchesContains(child,value)))return false;
  if(rule.oneOf&&rule.oneOf.filter(child=>matchesContains(child,value)).length!==1)return false;
  if(rule.not&&matchesContains(rule.not,value))return false;
  if(rule.conditional){const branch=matchesContains(rule.conditional.condition,value)?rule.conditional.then:rule.conditional.else;if(branch&&!matchesContains(branch,value))return false;}
  if(rule.choices&&!rule.choices.includes(canonicalFormValue(value)))return false;
  if(rule.type!==undefined){
    const types=Array.isArray(rule.type)?rule.type:[rule.type];
    if(!types.some(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='integer'?typeof value==='number'&&Number.isInteger(value):typeof value===type))return false;
  }
  if(typeof value==='number'){
    if(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum||rule.exclusiveMinimum!==undefined&&value<=rule.exclusiveMinimum||rule.exclusiveMaximum!==undefined&&value>=rule.exclusiveMaximum||rule.multipleOf!==undefined&&!decimalMultiple(value,rule.multipleOf))return false;
  }
  if(typeof value==='string'){
    const length=Array.from(value).length;
    if(rule.minLength!==undefined&&length<rule.minLength||rule.maxLength!==undefined&&length>rule.maxLength||rule.pattern&&!rule.pattern.test(value))return false;
  }
  if(Array.isArray(value)){
    if(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)return false;
    if(rule.uniqueItems&&new Set(value.map(canonicalFormValue)).size!==value.length)return false;
    if(rule.items&&!value.every(item=>matchesContains(rule.items,item)))return false;
    if(rule.contains){const count=value.filter(item=>matchesContains(rule.contains,item)).length;if(count<rule.contains.min||(rule.contains.max!==undefined&&count>rule.contains.max))return false;}
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
    const names=Object.keys(value);
    if(rule.minProperties!==undefined&&names.length<rule.minProperties||rule.maxProperties!==undefined&&names.length>rule.maxProperties||rule.propertyNames&&!names.every(name=>matchesContains(rule.propertyNames,name)))return false;
    if(rule.required.some(key=>!Object.hasOwn(value,key)))return false;
    for(const dependency of rule.dependentRequired)if(Object.hasOwn(value,dependency.trigger)&&dependency.required.some(key=>!Object.hasOwn(value,key)))return false;
    for(const dependency of rule.dependentSchemas)if(Object.hasOwn(value,dependency.trigger)&&!matchesContains(dependency.rule,value))return false;
    for(const [key,child] of Object.entries(value)){
      let matched=false;
      if(Object.hasOwn(rule.properties,key)){matched=true;if(!matchesContains(rule.properties[key],child))return false;}
      for(const entry of rule.patternProperties){if(entry.pattern.test(key)){matched=true;if(!matchesContains(entry.rule,child))return false;}}
      if(!matched&&rule.additionalProperties&&!matchesContains(rule.additionalProperties,child))return false;
    }
  }
  return true;
}
function canonicalFormValue(value){if(Array.isArray(value))return '['+value.map(canonicalFormValue).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalFormValue(value[key])).join(',')+'}';return JSON.stringify(value);}

function normalizeFields(fields) {
  if(fields===undefined)return undefined;
  if(!Array.isArray(fields)||fields.length<1||fields.length>40)throw Error('Invalid record fields');
  const seen=new Set();return fields.map(field=>{
    if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(key=>!['key','label','type','required','min','max','maxLength','options'].includes(key))||typeof field.key!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key)||['constructor','prototype','__proto__'].includes(field.key)||seen.has(field.key)||typeof field.label!=='string'||!field.label.trim()||field.label.length>120||!['string','number','integer','boolean'].includes(field.type)||(field.required!==undefined&&typeof field.required!=='boolean'))throw Error('Invalid record fields');
    seen.add(field.key);const numeric=field.type==='number'||field.type==='integer';
    if((field.min!==undefined&&(!numeric||!Number.isFinite(field.min)))||(field.max!==undefined&&(!numeric||!Number.isFinite(field.max)))||(field.min!==undefined&&field.max!==undefined&&field.min>field.max)||(field.maxLength!==undefined&&(field.type!=='string'||!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>4096))||(field.options!==undefined&&(field.type!=='string'||!Array.isArray(field.options)||field.options.length<1||field.options.length>100||field.options.some(value=>typeof value!=='string'||!value||value.length>120)||new Set(field.options).size!==field.options.length)))throw Error('Invalid record fields');
    return {key:field.key,label:field.label,type:field.type,required:field.required===true,...(field.min===undefined?{}:{min:field.min}),...(field.max===undefined?{}:{max:field.max}),...(field.maxLength===undefined?{}:{maxLength:field.maxLength}),...(field.options===undefined?{}:{options:[...field.options]})};
  });
}
function resolveFormSchema(root){
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);let count=0;
  const pointer=ref=>{
    if(ref==='#')return root;
    if(typeof ref!=='string'||!ref.startsWith('#/')||ref.includes('%'))throw Error('Unsupported record JSON Schema form');
    let value=root;for(const raw of ref.slice(2).split('/')){if(/~(?![01])/.test(raw))throw Error('Unsupported record JSON Schema form');const key=raw.replace(/~1/g,'/').replace(/~0/g,'~');if(!object(value)||!Object.hasOwn(value,key))throw Error('Unsupported record JSON Schema form');value=value[key];}return value;
  };
  const visit=(schema,stack,depth)=>{
    if(++count>1000||depth>30)throw Error('Unsupported record JSON Schema form');
    if(!object(schema))return schema;
    if(Object.hasOwn(schema,'$ref')){
      if(Object.keys(schema).some(key=>!['$ref','title','description'].includes(key))||typeof schema.$ref!=='string'||stack.includes(schema.$ref))throw Error('Unsupported record JSON Schema form');
      const resolved=visit(pointer(schema.$ref),[...stack,schema.$ref],depth+1);
      if(typeof resolved==='boolean'){
        if((schema.title!==undefined&&(typeof schema.title!=='string'||schema.title.length>120))||(schema.description!==undefined&&(typeof schema.description!=='string'||schema.description.length>1024)))throw Error('Unsupported record JSON Schema form');
        return resolved;
      }
      if(!object(resolved))throw Error('Unsupported record JSON Schema form');
      return {...resolved,...(Object.hasOwn(schema,'title')?{title:schema.title}:{}),...(Object.hasOwn(schema,'description')?{description:schema.description}:{})};
    }
    if(Object.hasOwn(schema,'$defs')&&!object(schema.$defs))throw Error('Unsupported record JSON Schema form');
    const result=Object.create(null);for(const [key,value] of Object.entries(schema)){
      if(key==='$defs')continue;
      if(['properties','patternProperties'].includes(key)&&object(value)){const properties=Object.create(null);for(const [name,child] of Object.entries(value))properties[name]=visit(child,stack,depth+1);result[key]=properties;}
      else if(['items','contains','propertyNames','additionalProperties','if','then','else','not'].includes(key))result[key]=visit(value,stack,depth+1);
      else if(['allOf','anyOf','oneOf'].includes(key)&&Array.isArray(value))result[key]=value.map(child=>visit(child,stack,depth+1));
      else if(key==='dependentSchemas'&&object(value)){const rules=Object.create(null);for(const [name,child] of Object.entries(value))rules[name]=visit(child,stack,depth+1);result[key]=rules;}
      else result[key]=value;
    }return result;
  };
  return visit(root,[],0);
}

function fieldsFromJsonSchema(jsonSchema,context={nodes:0},arrayDepth=0) {
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value), keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
  const fields=[],groups=[],dependencies=[],conditions=[],propertyCounts=[],propertyNames=[],objectRules=[];
  const ruleKeys=(value,allowed)=>keys(value,[...allowed,'title','description'])&&(value.title===undefined||(typeof value.title==='string'&&value.title.length<=120))&&(value.description===undefined||(typeof value.description==='string'&&value.description.length<=1024));
  const pattern=(value,type)=>{if(value===undefined)return undefined;if(type!=='string'||typeof value!=='string'||value.length>512)throw Error('Unsupported record JSON Schema form');try{return new RegExp(value,'u');}catch{throw Error('Unsupported record JSON Schema form');}};
  const numericConstraints=(schema,numeric)=>{const keys=['exclusiveMinimum','exclusiveMaximum','multipleOf'];for(const key of keys)if(schema[key]!==undefined&&(!numeric||typeof schema[key]!=='number'||!Number.isFinite(schema[key])||(key==='multipleOf'&&schema[key]<=0)))throw Error('Unsupported record JSON Schema form');return {...(schema.exclusiveMinimum===undefined?{}:{exclusiveMin:schema.exclusiveMinimum}),...(schema.exclusiveMaximum===undefined?{}:{exclusiveMax:schema.exclusiveMaximum}),...(schema.multipleOf===undefined?{}:{multipleOf:schema.multipleOf})};};
  const scalarType=type=>Array.isArray(type)&&type.length===2&&type.includes('null')&&new Set(type).size===2&&type.some(value=>['string','number','integer','boolean','object','array'].includes(value))?{type:type.find(value=>value!=='null'),nullable:true}:{type,nullable:false};
  const schemaScalar=value=>{if(Object.hasOwn(value,'_nullable')||Object.hasOwn(value,'_choices'))throw Error('Unsupported record JSON Schema form');if(Object.hasOwn(value,'const')){const {const:fixed,...rest}=value;if(value.enum!==undefined){if(!Array.isArray(value.enum))throw Error('Unsupported record JSON Schema form');schemaScalar(rest);if(!value.enum.includes(fixed))throw Error('Unsupported record JSON Schema form');}return schemaScalar({...rest,enum:[fixed]});}const result=scalarType(value.type);if(!['string','number','integer','boolean','object','array'].includes(result.type))return {...value};const copy={...value,type:result.type};let nullable=result.nullable;if(value.enum!==undefined){if(!['string','number','integer','boolean'].includes(result.type)||!Array.isArray(value.enum)||value.enum.length<1||value.enum.length>100||new Set(value.enum).size!==value.enum.length||value.enum.some(choice=>choice===null?!nullable:result.type==='string'?typeof choice!=='string'||choice.length>120:result.type==='boolean'?typeof choice!=='boolean':typeof choice!=='number'||!Number.isFinite(choice)||(result.type==='integer'&&!Number.isSafeInteger(choice))))throw Error('Unsupported record JSON Schema form');nullable=nullable&&value.enum.includes(null);copy._choices=value.enum.filter(choice=>choice!==null);delete copy.enum;}return nullable?{...copy,_nullable:true}:copy;};
  function canonicalSchemaValue(value,ancestors=new Set(),depth=0){
    context.literalNodes=(context.literalNodes??0)+1;
    if(context.literalNodes>1000||depth>20)throw Error('Unsupported record JSON Schema form');
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=1024)return JSON.stringify(value);
    if(!value||typeof value!=='object'||ancestors.has(value))throw Error('Unsupported record JSON Schema form');
    if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw Error('Unsupported record JSON Schema form');
    const next=new Set(ancestors);next.add(value);
    if(Array.isArray(value)){
      if(value.length>1000||Object.keys(value).length!==value.length)throw Error('Unsupported record JSON Schema form');
      for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i))throw Error('Unsupported record JSON Schema form');
      return '['+value.map(item=>canonicalSchemaValue(item,next,depth+1)).join(',')+']';
    }
    const keys=Object.keys(value).sort();if(keys.length>1000||keys.some(key=>key.length>1024))throw Error('Unsupported record JSON Schema form');
    return '{'+keys.map(key=>JSON.stringify(key)+':'+canonicalSchemaValue(value[key],next,depth+1)).join(',')+'}';
  }
  function compileContains(spec,depth){
    if(++context.nodes>200||depth>5)throw Error('Unsupported record JSON Schema form');
    if(typeof spec==='boolean')return {always:spec};
    if(!object(spec)||!ruleKeys(spec,['type','const','enum','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','properties','patternProperties','required','dependentRequired','dependentSchemas','additionalProperties','minProperties','maxProperties','propertyNames','items','minItems','maxItems','uniqueItems','contains','minContains','maxContains','allOf','anyOf','oneOf','not','if','then','else']))throw Error('Unsupported record JSON Schema form');
    const allowedTypes=['string','number','integer','boolean','null','object','array'],types=spec.type===undefined?undefined:Array.isArray(spec.type)?spec.type:[spec.type];
    if(types!==undefined&&(!types.length||types.length>allowedTypes.length||types.some(type=>!allowedTypes.includes(type))||new Set(types).size!==types.length))throw Error('Unsupported record JSON Schema form');
    for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'])if(spec[key]!==undefined&&(typeof spec[key]!=='number'||!Number.isFinite(spec[key])||(key==='multipleOf'&&spec[key]<=0)))throw Error('Unsupported record JSON Schema form');
    for(const key of ['minLength','maxLength'])if(spec[key]!==undefined&&(!Number.isSafeInteger(spec[key])||spec[key]<0||spec[key]>1048576))throw Error('Unsupported record JSON Schema form');
    const regex=pattern(spec.pattern,'string'),hasConst=Object.hasOwn(spec,'const'),hasEnum=Object.hasOwn(spec,'enum');
    if(hasEnum&&(!Array.isArray(spec.enum)||spec.enum.length<1||spec.enum.length>100))throw Error('Unsupported record JSON Schema form');
    const enumChoices=hasEnum?spec.enum.map(value=>canonicalSchemaValue(value)):undefined,fixed=hasConst?canonicalSchemaValue(spec.const):undefined;
    if((enumChoices&&new Set(enumChoices).size!==enumChoices.length)||(hasConst&&enumChoices&&!enumChoices.includes(fixed)))throw Error('Unsupported record JSON Schema form');

    for(const key of ['minProperties','maxProperties'])if(spec[key]!==undefined&&(!Number.isSafeInteger(spec[key])||spec[key]<0||spec[key]>1048576))throw Error('Unsupported record JSON Schema form');
    if(spec.properties!==undefined&&(!object(spec.properties)||Object.keys(spec.properties).length>40))throw Error('Unsupported record JSON Schema form');
    const validDependencyNames=names=>Array.isArray(names)&&names.length<=40&&names.every(key=>typeof key==='string'&&key.length<=256)&&new Set(names).size===names.length;
    if(spec.required!==undefined&&!validDependencyNames(spec.required))throw Error('Unsupported record JSON Schema form');
    if(spec.dependentRequired!==undefined&&(!object(spec.dependentRequired)||Object.keys(spec.dependentRequired).length>40))throw Error('Unsupported record JSON Schema form');
    if(spec.dependentSchemas!==undefined&&(!object(spec.dependentSchemas)||Object.keys(spec.dependentSchemas).length>40))throw Error('Unsupported record JSON Schema form');
    const dependentRequired=[];for(const [trigger,required] of Object.entries(spec.dependentRequired??{})){if(trigger.length>256||!validDependencyNames(required))throw Error('Unsupported record JSON Schema form');dependentRequired.push({trigger,required:[...required]});}
    const normalizeTargetObject=value=>{
      if(!object(value))return value;
      const out={...value};if(out.type===undefined)out.type='object';
      for(const key of ['allOf','anyOf','oneOf'])if(Array.isArray(out[key]))out[key]=out[key].map(normalizeTargetObject);
      for(const key of ['not','if','then','else'])if(out[key]!==undefined)out[key]=normalizeTargetObject(out[key]);
      return out;
    };
    const dependentSchemas=[];for(const [trigger,child] of Object.entries(spec.dependentSchemas??{})){if(trigger.length>256)throw Error('Unsupported record JSON Schema form');dependentSchemas.push({trigger,rule:compileContains(normalizeTargetObject(child),depth+1)});}
    if(spec.patternProperties!==undefined&&(!object(spec.patternProperties)||Object.keys(spec.patternProperties).length>40))throw Error('Unsupported record JSON Schema form');
    if(spec.additionalProperties!==undefined&&typeof spec.additionalProperties!=='boolean'&&!object(spec.additionalProperties))throw Error('Unsupported record JSON Schema form');
    for(const key of ['minItems','maxItems'])if(spec[key]!==undefined&&(!Number.isSafeInteger(spec[key])||spec[key]<0||spec[key]>1048576))throw Error('Unsupported record JSON Schema form');
    if(spec.uniqueItems!==undefined&&typeof spec.uniqueItems!=='boolean')throw Error('Unsupported record JSON Schema form');
    if(spec.contains===undefined&&(spec.minContains!==undefined||spec.maxContains!==undefined))throw Error('Unsupported record JSON Schema form');
    const min=spec.minContains??1,max=spec.maxContains;
    if(spec.contains!==undefined&&(!Number.isSafeInteger(min)||min<0||(max!==undefined&&(!Number.isSafeInteger(max)||max<0||max<min))))throw Error('Unsupported record JSON Schema form');
    const properties=Object.create(null);for(const [key,value] of Object.entries(spec.properties??{})){if(key.length>256)throw Error('Unsupported record JSON Schema form');properties[key]=compileContains(value,depth+1);}
    const patternProperties=[];for(const [key,value] of Object.entries(spec.patternProperties??{}))patternProperties.push({pattern:pattern(key,'string'),rule:compileContains(value,depth+1)});
    const additionalProperties=spec.additionalProperties===undefined?undefined:compileContains(spec.additionalProperties,depth+1);
    const nameSpec=spec.propertyNames===undefined?undefined:object(spec.propertyNames)&&spec.propertyNames.type===undefined?{...spec.propertyNames,type:'string'}:spec.propertyNames;
    const propertyNames=nameSpec===undefined?undefined:compileContains(nameSpec,depth+1),items=spec.items===undefined?undefined:compileContains(spec.items,depth+1),contains=spec.contains===undefined?undefined:{...compileContains(spec.contains,depth+1),min,max};
    const combinations={};for(const key of ['allOf','anyOf','oneOf'])if(spec[key]!==undefined){if(!Array.isArray(spec[key])||spec[key].length<1||spec[key].length>40)throw Error('Unsupported record JSON Schema form');combinations[key]=spec[key].map(child=>compileContains(child,depth+1));}
    const not=spec.not===undefined?undefined:compileContains(spec.not,depth+1);
    if(spec.if===undefined&&(spec.then!==undefined||spec.else!==undefined)||spec.if!==undefined&&spec.then===undefined&&spec.else===undefined)throw Error('Unsupported record JSON Schema form');
    const conditional=spec.if===undefined?undefined:{condition:compileContains(spec.if,depth+1),then:spec.then===undefined?undefined:compileContains(spec.then,depth+1),else:spec.else===undefined?undefined:compileContains(spec.else,depth+1)};
    return {type:Array.isArray(spec.type)?[...spec.type]:spec.type,choices:hasConst?[fixed]:enumChoices,minimum:spec.minimum,maximum:spec.maximum,exclusiveMinimum:spec.exclusiveMinimum,exclusiveMaximum:spec.exclusiveMaximum,multipleOf:spec.multipleOf,minLength:spec.minLength,maxLength:spec.maxLength,pattern:regex,properties,patternProperties,required:spec.required===undefined?[]:[...spec.required],dependentRequired,dependentSchemas,additionalProperties,minProperties:spec.minProperties,maxProperties:spec.maxProperties,propertyNames,items,minItems:spec.minItems,maxItems:spec.maxItems,uniqueItems:spec.uniqueItems===true,contains,...combinations,not,conditional};
  }
  function visit(node,path,labels,needed,depth){
    if(++context.nodes>200||arrayDepth>3)throw Error('Unsupported record JSON Schema form');
    if(depth>5||!object(node)||!keys(node,depth===0?['$schema','type','description','properties','patternProperties','required','additionalProperties','dependentRequired','dependentSchemas','if','then','else','minProperties','maxProperties','propertyNames','allOf','anyOf','oneOf','not']:['type','title','description','properties','patternProperties','required','additionalProperties','dependentRequired','dependentSchemas','if','then','else','minProperties','maxProperties','propertyNames','allOf','anyOf','oneOf','not','_nullable'])||node.type!=='object'||!object(node.properties)||(node.title!==undefined&&(typeof node.title!=='string'||!node.title.trim()||node.title.length>120))||(node.description!==undefined&&(typeof node.description!=='string'||node.description.length>1024))||(node.additionalProperties!==undefined&&typeof node.additionalProperties!=='boolean'&&!object(node.additionalProperties))||(depth===0&&node.$schema!==undefined&&node.$schema!=='https://json-schema.org/draft/2020-12/schema'))throw Error('Unsupported record JSON Schema form');
    if((node.minProperties!==undefined&&(!Number.isSafeInteger(node.minProperties)||node.minProperties<0))||(node.maxProperties!==undefined&&(!Number.isSafeInteger(node.maxProperties)||node.maxProperties<0))||(node.minProperties!==undefined&&node.maxProperties!==undefined&&node.minProperties>node.maxProperties))throw Error('Unsupported record JSON Schema form');
    if(node.minProperties!==undefined||node.maxProperties!==undefined)propertyCounts.push({path:[...path],min:node.minProperties,max:node.maxProperties});
    if(node.propertyNames!==undefined)propertyNames.push({path:[...path],rule:compileContains(node.propertyNames,0)});
    const required=node.required===undefined?[]:node.required;if(!Array.isArray(required)||required.some(key=>typeof key!=='string'||!Object.hasOwn(node.properties,key))||new Set(required).size!==required.length)throw Error('Unsupported record JSON Schema form');
    const validNames=names=>Array.isArray(names)&&names.length<=40&&names.every(key=>typeof key==='string'&&Object.hasOwn(node.properties,key))&&new Set(names).size===names.length;
    const normalizeObjectRule=value=>{
      if(!object(value))return value;
      if(value.properties!==undefined&&(!object(value.properties)||Object.keys(value.properties).some(key=>!Object.hasOwn(node.properties,key))))throw Error('Unsupported record JSON Schema form');
      if(value.required!==undefined&&!validNames(value.required))throw Error('Unsupported record JSON Schema form');
      const out={...value};
      if(out.type===undefined&&['properties','patternProperties','required','dependentRequired','dependentSchemas','additionalProperties','minProperties','maxProperties','propertyNames'].some(key=>Object.hasOwn(out,key)))out.type='object';
      for(const key of ['allOf','anyOf','oneOf'])if(Array.isArray(out[key]))out[key]=out[key].map(normalizeObjectRule);
      if(out.not!==undefined)out.not=normalizeObjectRule(out.not);
      return out;
    };
    const objectRuleFor=(value,predicates)=>{
      const combined={type:'object',minProperties:value.minProperties,maxProperties:value.maxProperties,propertyNames:value.propertyNames,patternProperties:value.patternProperties,additionalProperties:value.additionalProperties};
      for(const key of ['allOf','anyOf','oneOf'])if(value[key]!==undefined)combined[key]=Array.isArray(value[key])?value[key].map(normalizeObjectRule):value[key];
      if(value.not!==undefined)combined.not=normalizeObjectRule(value.not);
      const rule=compileContains(combined,0);
      for(const predicate of predicates)rule.properties[predicate.key]=predicate.rule;
      return rule;
    };
    const branch=value=>{
      if(value===undefined)return {required:[],predicates:[]};
      if(typeof value==='boolean')return {required:[],predicates:[],objectRule:compileContains(value,0)};
      if(!object(value)||!ruleKeys(value,['required','properties','patternProperties','minProperties','maxProperties','propertyNames','additionalProperties','allOf','anyOf','oneOf','not'])||!['required','properties','patternProperties','minProperties','maxProperties','propertyNames','additionalProperties','allOf','anyOf','oneOf','not'].some(key=>Object.hasOwn(value,key))||(value.required!==undefined&&!validNames(value.required))||(value.properties!==undefined&&(!object(value.properties)||Object.keys(value.properties).length>40)))throw Error('Unsupported record JSON Schema form');
      const predicates=[];for(const [key,test] of Object.entries(value.properties??{})){if(!Object.hasOwn(node.properties,key))throw Error('Unsupported record JSON Schema form');predicates.push({key,rule:compileContains(test,0)});}
      return {required:[...(value.required??[])],predicates,objectRule:objectRuleFor(value,predicates)};
    };
    if(['allOf','anyOf','oneOf','not'].some(key=>node[key]!==undefined)){
      const combined={type:'object'};for(const key of ['allOf','anyOf','oneOf'])if(node[key]!==undefined)combined[key]=Array.isArray(node[key])?node[key].map(normalizeObjectRule):node[key];
      if(node.not!==undefined)combined.not=normalizeObjectRule(node.not);
      objectRules.push({path:[...path],rule:compileContains(combined,0)});if(objectRules.length>40)throw Error('Unsupported record JSON Schema form');
    }
    if(node.patternProperties!==undefined||node.additionalProperties!==undefined){
      const rule=compileContains({type:'object',patternProperties:node.patternProperties,additionalProperties:node.additionalProperties},0);
      for(const key of Object.keys(node.properties))rule.properties[key]={always:true};
      objectRules.push({path:[...path],rule});if(objectRules.length>40)throw Error('Unsupported record JSON Schema form');
    }
    if(node.dependentRequired!==undefined){if(!object(node.dependentRequired)||Object.keys(node.dependentRequired).length>40)throw Error('Unsupported record JSON Schema form');for(const [trigger,requiredKeys] of Object.entries(node.dependentRequired)){if(!Object.hasOwn(node.properties,trigger)||!Array.isArray(requiredKeys)||requiredKeys.length>40||requiredKeys.some(key=>typeof key!=='string'||!Object.hasOwn(node.properties,key))||new Set(requiredKeys).size!==requiredKeys.length)throw Error('Unsupported record JSON Schema form');dependencies.push({path:[...path],trigger,required:[...requiredKeys]});if(dependencies.length>40)throw Error('Unsupported record JSON Schema form');}}
    if(node.dependentSchemas!==undefined){if(!object(node.dependentSchemas)||Object.keys(node.dependentSchemas).length>40)throw Error('Unsupported record JSON Schema form');for(const [trigger,schema] of Object.entries(node.dependentSchemas)){if(!Object.hasOwn(node.properties,trigger)||schema===undefined)throw Error('Unsupported record JSON Schema form');dependencies.push({path:[...path],trigger,...branch(schema)});if(dependencies.length>40)throw Error('Unsupported record JSON Schema form');}}
    if(node.if!==undefined||node.then!==undefined||node.else!==undefined){
      const condition=node.if;
      if(node.then===undefined&&node.else===undefined)throw Error('Unsupported record JSON Schema form');
      if(typeof condition==='boolean'){
        conditions.push({path:[...path],predicates:[],required:[],objectRule:compileContains(condition,0),then:branch(node.then),else:branch(node.else)});
      }else{
        if(!object(condition)||!ruleKeys(condition,['properties','patternProperties','required','minProperties','maxProperties','propertyNames','additionalProperties','allOf','anyOf','oneOf','not'])||!['properties','patternProperties','required','minProperties','maxProperties','propertyNames','additionalProperties','allOf','anyOf','oneOf','not'].some(key=>Object.hasOwn(condition,key))||(condition.required!==undefined&&!validNames(condition.required))||(condition.properties!==undefined&&(!object(condition.properties)||Object.keys(condition.properties).length>40)))throw Error('Unsupported record JSON Schema form');
        const predicates=[];for(const [key,test] of Object.entries(condition.properties??{})){if(!Object.hasOwn(node.properties,key))throw Error('Unsupported record JSON Schema form');predicates.push({key,rule:compileContains(test,0)});}
        conditions.push({path:[...path],predicates,required:[...(condition.required??[])],objectRule:objectRuleFor(condition,predicates),then:branch(node.then),else:branch(node.else)});
      }
      if(conditions.length>40)throw Error('Unsupported record JSON Schema form');
    }
    if(depth){groups.push({path, label:labels.join(' / '), required:needed,nullable:node._nullable===true,description:node.description});if(groups.length>40)throw Error('Unsupported record JSON Schema form');}
    for(const [key,originalProperty] of Object.entries(node.properties)){
      const property=object(originalProperty)?schemaScalar(originalProperty):originalProperty;
      if(++context.nodes>200)throw Error('Unsupported record JSON Schema form');
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)||['constructor','prototype','__proto__'].includes(key)||!object(property))throw Error('Unsupported record JSON Schema form');
      const next=[...path,key],name=property.title??key,requiredField=required.includes(key);
      if(property.type==='object'){visit(property,next,[...labels,name],requiredField,depth+1);continue;}
      if(property.type==='array'){
        if(property.description!==undefined&&(typeof property.description!=='string'||property.description.length>1024))throw Error('Unsupported record JSON Schema form');
        let contains;
        if(property.contains!==undefined){
          const min=property.minContains??1,max=property.maxContains;
          if(!Number.isSafeInteger(min)||min<0||(max!==undefined&&(!Number.isSafeInteger(max)||max<0||max<min)))throw Error('Unsupported record JSON Schema form');
          contains={...compileContains(property.contains,0),min,max};
        }else if(property.minContains!==undefined||property.maxContains!==undefined)throw Error('Unsupported record JSON Schema form');
        if(object(property.items)&&scalarType(property.items.type).type==='array'){
          const minItems=property.minItems===undefined?0:property.minItems,maxItems=property.maxItems===undefined?50:property.maxItems;
          if(!keys(property,['type','title','description','items','minItems','maxItems','uniqueItems','contains','minContains','maxContains','_nullable'])||(property.uniqueItems!==undefined&&typeof property.uniqueItems!=='boolean')||!Number.isSafeInteger(minItems)||!Number.isSafeInteger(maxItems)||minItems<0||maxItems<minItems||maxItems>50||(property.title!==undefined&&(typeof property.title!=='string'||!property.title.trim()||property.title.length>120)))throw Error('Unsupported record JSON Schema form');
          const item=fieldsFromJsonSchema({type:'object',properties:{item:property.items},required:['item']},context,arrayDepth+1)[0],label=[...labels,name].join(' / ');if(label.length>120)throw Error('Unsupported record JSON Schema form');fields.push({key,label,...(property.description===undefined?{}:{description:property.description}),type:'array',path:next,required:requiredField,nullable:property._nullable===true,item,minItems,maxItems,uniqueItems:property.uniqueItems===true,contains});if(fields.length>40)throw Error('Unsupported record JSON Schema form');continue;
        }
        if(object(property.items)&&scalarType(property.items.type).type==='object'){
          const spec=schemaScalar(property.items),minItems=property.minItems===undefined?0:property.minItems,maxItems=property.maxItems===undefined?50:property.maxItems;
          if(!keys(property,['type','title','description','items','minItems','maxItems','uniqueItems','contains','minContains','maxContains','_nullable'])||!keys(spec,['type','title','description','properties','patternProperties','required','additionalProperties','dependentRequired','dependentSchemas','if','then','else','minProperties','maxProperties','propertyNames','allOf','anyOf','oneOf','not','_nullable'])||!object(spec.properties)||(property.uniqueItems!==undefined&&typeof property.uniqueItems!=='boolean')||!Number.isSafeInteger(minItems)||!Number.isSafeInteger(maxItems)||minItems<0||maxItems<minItems||maxItems>50||(property.title!==undefined&&(typeof property.title!=='string'||!property.title.trim()||property.title.length>120))||(spec.title!==undefined&&(typeof spec.title!=='string'||!spec.title.trim()||spec.title.length>120))||(spec.description!==undefined&&(typeof spec.description!=='string'||spec.description.length>1024)))throw Error('Unsupported record JSON Schema form');
          const {title:unused,description:itemDescription,_nullable:itemNullable,...itemSchema}=spec,itemFields=fieldsFromJsonSchema(itemSchema,context,arrayDepth+1),label=[...labels,name].join(' / ');if(label.length>120)throw Error('Unsupported record JSON Schema form');fields.push({key,label,...(property.description===undefined?{}:{description:property.description}),type:'objectArray',path:next,required:requiredField,nullable:property._nullable===true,itemNullable:itemNullable===true,itemDescription,itemFields,minItems,maxItems,uniqueItems:property.uniqueItems===true,contains});if(fields.length>40)throw Error('Unsupported record JSON Schema form');continue;
        }
        if(!keys(property,['type','title','description','items','minItems','maxItems','uniqueItems','contains','minContains','maxContains','_nullable'])||!object(property.items)||!keys(property.items,['type','description','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern'])||!['string','number','integer','boolean'].includes(scalarType(property.items.type).type)||(property.title!==undefined&&(typeof property.title!=='string'||!property.title.trim()||property.title.length>120)))throw Error('Unsupported record JSON Schema form');
        const spec=schemaScalar(property.items),numeric=spec.type==='number'||spec.type==='integer',minItems=property.minItems===undefined?0:property.minItems,maxItems=property.maxItems===undefined?50:property.maxItems;
        if((property.uniqueItems!==undefined&&typeof property.uniqueItems!=='boolean')||!Number.isSafeInteger(minItems)||!Number.isSafeInteger(maxItems)||minItems<0||maxItems<minItems||maxItems>50||((spec.minimum!==undefined||spec.maximum!==undefined)&&!numeric)||(spec.minLength!==undefined&&(spec.type!=='string'||!Number.isSafeInteger(spec.minLength)||spec.minLength<0||spec.minLength>1048576))||(spec.maxLength!==undefined&&(spec.type!=='string'||!Number.isSafeInteger(spec.maxLength)||spec.maxLength<0||spec.maxLength>1048576))||(spec.minLength!==undefined&&spec.maxLength!==undefined&&spec.minLength>spec.maxLength))throw Error('Unsupported record JSON Schema form');
        let item;try{item=normalizeFields([{key,label:'Item',type:spec.type,required:true,...(spec.minimum===undefined?{}:{min:spec.minimum}),...(spec.maximum===undefined?{}:{max:spec.maximum})}])[0];}catch{throw Error('Unsupported record JSON Schema form');}
        if(spec.description!==undefined&&(typeof spec.description!=='string'||spec.description.length>1024))throw Error('Unsupported record JSON Schema form');
        item={...item,...(spec.description===undefined?{}:{description:spec.description}),...numericConstraints(spec,numeric),...(spec._choices===undefined?{}:{jsonChoices:[...spec._choices]})};if(spec._nullable)item={...item,nullable:true};const itemPattern=pattern(spec.pattern,spec.type);if(itemPattern)item={...item,jsonPattern:itemPattern};
        if(spec.type==='string')item={...item,jsonString:true,...(spec.minLength===undefined?{}:{jsonMinLength:spec.minLength}),...(spec.maxLength===undefined?{}:{jsonMaxLength:spec.maxLength})};
        const label=[...labels,name].join(' / ');if(label.length>120)throw Error('Unsupported record JSON Schema form');fields.push({key,label,...(property.description===undefined?{}:{description:property.description}),type:'array',path:next,required:requiredField,nullable:property._nullable===true,item,minItems,maxItems,uniqueItems:property.uniqueItems===true,contains});if(fields.length>40)throw Error('Unsupported record JSON Schema form');continue;
      }
      if(!keys(property,['type','title','description','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','_nullable','_choices'])||!['string','number','integer','boolean'].includes(property.type)||(property.title!==undefined&&typeof property.title!=='string'))throw Error('Unsupported record JSON Schema form');
      const numeric=property.type==='number'||property.type==='integer';if((property.description!==undefined&&(typeof property.description!=='string'||property.description.length>1024))||((property.minimum!==undefined||property.maximum!==undefined)&&!numeric)||(property.minLength!==undefined&&(property.type!=='string'||!Number.isSafeInteger(property.minLength)||property.minLength<0||property.minLength>1048576))||(property.maxLength!==undefined&&(property.type!=='string'||!Number.isSafeInteger(property.maxLength)||property.maxLength<0||property.maxLength>1048576))||(property.minLength!==undefined&&property.maxLength!==undefined&&property.minLength>property.maxLength))throw Error('Unsupported record JSON Schema form');
      const fieldPattern=pattern(property.pattern,property.type);const field={key,label:[...labels,name].join(' / '),type:property.type,required:requiredField,...(property.minimum===undefined?{}:{min:property.minimum}),...(property.maximum===undefined?{}:{max:property.maximum})};
      try{fields.push({...normalizeFields([field])[0],path:next,...(property.description===undefined?{}:{description:property.description}),...numericConstraints(property,numeric),...(property._choices===undefined?{}:{jsonChoices:[...property._choices]}),...(fieldPattern?{jsonPattern:fieldPattern}:{}),...(property._nullable?{nullable:true}:{}),...(property.type==='string'?{jsonString:true,...(property.minLength===undefined?{}:{jsonMinLength:property.minLength}),...(property.maxLength===undefined?{}:{jsonMaxLength:property.maxLength})}:{})});}catch{throw Error('Unsupported record JSON Schema form');}
      if(fields.length>40)throw Error('Unsupported record JSON Schema form');
    }
  }
  visit(jsonSchema,[],[],true,0);if(!fields.length)throw Error('Unsupported record JSON Schema form');fields.description=jsonSchema.description;fields.groups=groups;fields.dependencies=dependencies;fields.conditions=conditions;fields.propertyCounts=propertyCounts;fields.propertyNames=propertyNames;fields.objectRules=objectRules;return fields;
}

function pathValue(value,path){for(const key of path){if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
function validateFormObjectRules(rules,value){for(const item of rules??[]){const current=pathValue(value,item.path);if(!current||typeof current!=='object'||Array.isArray(current))continue;if(!matchesContains(item.rule,current))throw Error((item.path.length?item.path.join(' / ')+' ': 'Object ')+'does not satisfy the schema rules.');}}
function validateFormDependencies(dependencies,value){for(const rule of dependencies??[]){const current=pathValue(value,rule.path);if(!current||typeof current!=='object'||Array.isArray(current)||!Object.hasOwn(current,rule.trigger))continue;const prefix=rule.path.length?rule.path.join(' / ')+' / ':'';for(const required of rule.required)if(!Object.hasOwn(current,required))throw Error(prefix+required+' is required when '+rule.trigger+' is provided.');for(const test of rule.predicates??[])if(Object.hasOwn(current,test.key)&&!matchesContains(test.rule,current[test.key]))throw Error(prefix+test.key+' does not satisfy the dependency for '+rule.trigger+'.');if(rule.objectRule&&!matchesContains(rule.objectRule,current))throw Error(prefix+'object does not satisfy the dependency for '+rule.trigger+'.');}}
function validateFormConditions(conditions,value){for(const rule of conditions??[]){const current=pathValue(value,rule.path);if(!current||typeof current!=='object'||Array.isArray(current))continue;const matched=rule.required.every(key=>Object.hasOwn(current,key))&&rule.predicates.every(test=>!Object.hasOwn(current,test.key)||matchesContains(test.rule,current[test.key]))&&matchesContains(rule.objectRule,current),branch=matched?rule.then:rule.else,prefix=rule.path.length?rule.path.join(' / ')+' / ':'';for(const required of branch.required)if(!Object.hasOwn(current,required))throw Error(prefix+required+' is required by a condition.');for(const test of branch.predicates)if(Object.hasOwn(current,test.key)&&!matchesContains(test.rule,current[test.key]))throw Error(prefix+test.key+' does not satisfy a condition.');if(branch.objectRule&&!matchesContains(branch.objectRule,current))throw Error(prefix+'object does not satisfy a condition.');}}
function pathParent(value,path){for(const key of path.slice(0,-1))value=value[key];return value;}
function pathActive(groups,path){return groups.filter(group=>group.path.length<path.length&&group.path.every((key,i)=>key===path[i])).every(group=>group.control.checked&&!(group.nullToggle&&group.nullToggle.checked));}

function descriptionHelp(document,target,text){if(!text)return undefined;const help=document.createElement('span'),key=Symbol.for('app-mixer.field-help-counter');let n=document[key]??0,id;do{id='app-mixer-field-help-'+(++n);}while(document.getElementById(id)||document.getElementById('app-mixer-field-label-'+n));document[key]=n;help.id=id;help.textContent=text;target.appendChild(help);return id;}
function groupControl(document,group,value){const wrapper=document.createElement('div'),label=document.createElement('label'),control=document.createElement('input');control.type='checkbox';control.checked=group.required||value!==undefined;label.append(control,document.createTextNode(' Include '+group.label+' (clearing removes this object)'));if(!group.required)wrapper.appendChild(label);let nullToggle;if(group.nullable){const nullLabel=document.createElement('label');nullToggle=document.createElement('input');nullToggle.type='checkbox';nullToggle.checked=value===null;nullLabel.append(nullToggle,document.createTextNode(' Set '+group.label+' to null'));wrapper.appendChild(nullLabel);}const help=descriptionHelp(document,wrapper,group.description);if(help){if(!group.required)control.setAttribute('aria-describedby',help);nullToggle?.setAttribute('aria-describedby',help);}return {...group,control,nullToggle,wrapper,help,dirty:false};}
function linkGroupHelp(item,groups){for(const group of groups)if(group.help&&group.path.length<item.field.path.length&&group.path.every((key,i)=>key===item.field.path[i])){const current=item.control.getAttribute('aria-describedby');item.control.setAttribute('aria-describedby',current?current+' '+group.help:group.help);}}
function disableGroup(group,disabled){group.control.disabled=disabled;if(group.nullToggle)group.nullToggle.disabled=disabled||!group.control.checked;}

function fieldControl(document,field) {
  if(field.type==='array'||field.type==='objectArray'){
    const wrapper=document.createElement('div'),control=document.createElement('fieldset'),title=document.createElement('legend'),error=document.createElement('small'),list=document.createElement('div'),add=document.createElement('button');
    title.textContent=field.label+(field.required?' (required)':' (optional)');control.appendChild(title);if(field.description){const help=document.createElement('span'),key=Symbol.for('app-mixer.field-help-counter');let n=document[key]??0,id;do{id='app-mixer-field-help-'+(++n);}while(document.getElementById(id)||document.getElementById('app-mixer-field-label-'+n));document[key]=n;help.id=id;help.textContent=field.description;control.setAttribute('aria-describedby',id);control.appendChild(help);}let include;
    if(!field.required){const label=document.createElement('label');include=document.createElement('input');include.type='checkbox';label.append(include,document.createTextNode(' Include '+field.label));control.appendChild(label);}
    let nullToggle;if(field.nullable){const label=document.createElement('label');nullToggle=document.createElement('input');nullToggle.type='checkbox';label.append(nullToggle,document.createTextNode(' Set '+field.label+' to null'));control.appendChild(label);}
    add.type='button';add.textContent='Add '+field.label+' item';error.setAttribute('role','alert');control.append(list,add,error);wrapper.appendChild(control);const rows=[];
    const refresh=()=>{for(let i=0;i<rows.length;i++){if(rows[i].item){const itemControl=rows[i].item.control,title=itemControl.tagName==='FIELDSET'?itemControl.querySelector(':scope > legend'):itemControl.parentElement.firstChild;title.textContent=field.label+' item '+(i+1)+' (required)';}else rows[i].legend.textContent=field.label+' item '+(i+1);}if(nullToggle)nullToggle.disabled=control.disabled||(!field.required&&!include.checked);add.disabled=control.disabled||(!field.required&&!include.checked)||(nullToggle&&nullToggle.checked)||rows.length>=field.maxItems;for(const row of rows){const parentDisabled=control.disabled||(!field.required&&!include.checked)||(nullToggle&&nullToggle.checked);if(row.nullToggle)row.nullToggle.disabled=parentDisabled;const disabled=parentDisabled||(row.nullToggle&&row.nullToggle.checked);for(const group of row.groups??[])disableGroup(group,disabled||!pathActive(row.groups,group.path));for(const item of row.items??[row.item]){item.control.disabled=disabled||(row.groups&&!pathActive(row.groups,item.field.path));item.setDisabled?.(item.control.disabled);item.refresh?.();}row.remove.disabled=parentDisabled;}};
    const append=value=>{const remove=document.createElement('button'),row=document.createElement('div');remove.type='button';remove.textContent='Remove '+field.label+' item';let entry;
      if(field.type==='objectArray'){const box=document.createElement('fieldset'),legend=document.createElement('legend'),original=value===undefined||value===null?{}:JSON.parse(JSON.stringify(value)),groups=field.itemFields.groups.map(group=>groupControl(document,group,pathValue(original,group.path))),items=field.itemFields.map(child=>{const item=fieldControl(document,child),initial=pathValue(original,child.path);if(item.setValue)item.setValue(initial);else item.control.value=initial===undefined?'':String(initial);item.control.addEventListener('input',()=>{item.dirty=true});item.control.addEventListener('change',()=>{item.dirty=true});return item;});box.appendChild(legend);const itemHelp=descriptionHelp(document,box,field.itemDescription);if(itemHelp)box.setAttribute('aria-describedby',itemHelp);let nullToggle;if(field.itemNullable){const label=document.createElement('label');nullToggle=document.createElement('input');nullToggle.type='checkbox';nullToggle.checked=value===null;label.append(nullToggle,document.createTextNode(' Set '+field.label+' item to null'));box.appendChild(label);nullToggle.addEventListener('change',()=>{refresh();control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});}for(const group of groups){if(!group.required||group.nullable||group.description)box.appendChild(group.wrapper);for(const toggle of [group.control,group.nullToggle])toggle?.addEventListener('change',()=>{refresh();control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});}for(const item of items){linkGroupHelp(item,groups);box.appendChild(item.wrapper??item.control.parentElement);}row.append(box,remove);entry={items,groups,legend,original,nullToggle,remove,row};}
      else {const item=fieldControl(document,field.item);if(item.setValue)item.setValue(value);else if(value!==undefined)item.control.value=String(value);row.append(item.wrapper??item.control.parentElement,remove);entry={item,remove,row};}
      list.appendChild(row);rows.push(entry);remove.addEventListener('click',()=>{rows.splice(rows.indexOf(entry),1);row.remove();refresh();control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});refresh();};
    add.addEventListener('click',()=>{append(undefined);control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});if(include)include.addEventListener('change',refresh);if(nullToggle)nullToggle.addEventListener('change',refresh);
    return {field,control,error,dirty:false,rows,include,nullToggle,refresh,setValue(value){list.replaceChildren();rows.length=0;if(include)include.checked=value!==undefined;if(nullToggle)nullToggle.checked=value===null;if(value!==undefined&&value!==null)for(const item of value)append(item);refresh();}};
  }
  const label=document.createElement('label'),title=document.createElement('span'),error=document.createElement('small'),control=field.type==='boolean'||field.options||field.jsonChoices?document.createElement('select'):document.createElement('input');
  label.style.display='block';label.style.margin='0.75rem 0';title.style.display='block';control.style.display='block';control.style.width='100%';control.style.maxWidth='28rem';control.style.boxSizing='border-box';error.style.display='block';
  title.textContent=field.label+(field.required?' (required)':' (optional)');label.appendChild(title);
  if(control.tagName==='SELECT'){const choices=field.jsonChoices??(field.type==='boolean'?['true','false']:field.options);const blank=document.createElement('option');blank.value='';blank.textContent='Select an option';control.appendChild(blank);for(let index=0;index<choices.length;index++){const choice=choices[index],option=document.createElement('option');option.value=field.jsonChoices?String(index+1):choice;option.textContent=typeof choice==='boolean'?(choice?'Yes':'No'):field.type==='boolean'?(choice==='true'?'Yes':'No'):choice===''?'(empty)':String(choice);control.appendChild(option);}}
  else {control.type=field.type==='string'?'text':'number';if(field.type==='number')control.step='any';if(field.type==='integer')control.step='1';if(field.maxLength!==undefined)control.maxLength=field.maxLength;}
  control.required=field.required;error.setAttribute('role','alert');label.append(control);if(field.description){const help=document.createElement('span');const key=Symbol.for('app-mixer.field-help-counter');let n=document[key]??0,id;do{id='app-mixer-field-help-'+(++n);}while(document.getElementById(id)||document.getElementById('app-mixer-field-label-'+n));document[key]=n;title.id='app-mixer-field-label-'+n;help.id=id;help.textContent=field.description;control.setAttribute('aria-labelledby',title.id);control.setAttribute('aria-describedby',id);label.appendChild(help);}label.appendChild(error);
  if(field.jsonString||field.nullable||field.jsonChoices){let include,nullToggle,wrapper,disabled=false;if(field.jsonString&&!field.required||field.nullable){wrapper=document.createElement('div');if(field.jsonString&&!field.required){const includeLabel=document.createElement('label');include=document.createElement('input');include.type='checkbox';includeLabel.append(include,document.createTextNode(' Include '+field.label));wrapper.appendChild(includeLabel);}if(field.nullable){const nullLabel=document.createElement('label');nullToggle=document.createElement('input');nullToggle.type='checkbox';nullLabel.append(nullToggle,document.createTextNode(' Set '+field.label+' to null'));wrapper.appendChild(nullLabel);}wrapper.appendChild(label);}const update=()=>{if(include)include.disabled=disabled;if(nullToggle)nullToggle.disabled=disabled||(include&&!include.checked);control.disabled=disabled||(include&&!include.checked)||(nullToggle&&nullToggle.checked);};for(const toggle of [include,nullToggle])toggle?.addEventListener('change',()=>{update();control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});return {field,control,error,dirty:false,include,nullToggle,wrapper,setDisabled(value){disabled=value;update();},setValue(value){if(include)include.checked=value!==undefined;if(nullToggle)nullToggle.checked=value===null;control.value=value===undefined||value===null?'':field.jsonChoices?String(field.jsonChoices.indexOf(value)+1):String(value);update();}};}
  return {field,control,error,dirty:false};
}

export function createRecordEditor({getOperation,putOperation,listOperation,filterFields,rangeFilterFields,multipleFilters,fields,jsonSchema,expectedSchemaVersion}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation)||(listOperation!==undefined&&!validOperation(listOperation)))throw Error('Invalid record editor capabilities');
  if(filterFields!==undefined&&(!listOperation||!Array.isArray(filterFields)||filterFields.length<1||filterFields.length>40||new Set(filterFields.map(x=>x?.field)).size!==filterFields.length||!filterFields.every(x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>['field','label','type'].includes(k))&&typeof x.field==='string'&&/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(x.field)&&!['__proto__','prototype','constructor'].includes(x.field)&&typeof x.label==='string'&&!!x.label.trim()&&x.label.length<=120&&['string','number','boolean'].includes(x.type))))throw Error('Invalid record filter fields');
  if(multipleFilters!==undefined&&(typeof multipleFilters!=='boolean'||multipleFilters&&!filterFields))throw Error('Invalid record filter fields');
  if(rangeFilterFields!==undefined&&(!Array.isArray(rangeFilterFields)||new Set(rangeFilterFields).size!==rangeFilterFields.length||!rangeFilterFields.every(field=>filterFields?.some(item=>item.field===field&&item.type==='number'))))throw Error('Invalid record filter fields');
  const filters=filterFields?.map(x=>({...x}));
  const rangeFields=new Set(rangeFilterFields??[]);
  if(expectedSchemaVersion!==undefined&&(!Number.isSafeInteger(expectedSchemaVersion)||expectedSchemaVersion<0))throw Error('Invalid record schema version');
  if(fields!==undefined&&jsonSchema!==undefined)throw Error('Invalid record editor schema');
  const schema=jsonSchema===undefined?normalizeFields(fields):fieldsFromJsonSchema(resolveFormSchema(jsonSchema));
  const validate=component=>{
    if(!component||Object.keys(component).some(key=>!['id','component','label'].includes(key))||
       (component.label!==undefined&&(typeof component.label!=='string'||component.label.length>120)))throw Error('Invalid record editor');
  };
  const render=(component,_child,_data,document)=>{
    const root=document.createElement('section'),heading=document.createElement('h3'),idLabel=document.createElement('label'),id=document.createElement('input'),valueLabel=document.createElement('label'),value=document.createElement('textarea'),load=document.createElement('button'),save=document.createElement('button'),status=document.createElement('p');
    heading.textContent=component.label||'Record';idLabel.textContent='Record ID';valueLabel.textContent='Record data (JSON object)';
    id.disabled=true;value.disabled=true;idLabel.appendChild(id);valueLabel.appendChild(value);
    load.type='button';load.textContent='Load';load.disabled=true;save.type='button';save.textContent='Save';save.disabled=true;
    status.setAttribute('role','status');status.textContent='Preview only. Data operations are disabled.';
    root.append(heading);const schemaHelp=descriptionHelp(document,root,schema?.description);if(schemaHelp)root.setAttribute('aria-describedby',schemaHelp);if(listOperation){if(filters){const fieldLabel=document.createElement('label'),select=document.createElement('select'),all=document.createElement('option'),valueLabel=document.createElement('label'),value=document.createElement('input'),nullLabel=document.createElement('label'),nullInput=document.createElement('input');fieldLabel.textContent='Filter field';all.value='';all.textContent='All records';select.append(all);for(const f of filters){const option=document.createElement('option');option.value=f.field;option.textContent=f.label;select.append(option);}select.disabled=true;fieldLabel.append(select);valueLabel.textContent='Filter value';value.disabled=true;valueLabel.append(value);nullInput.type='checkbox';nullInput.disabled=true;nullLabel.append(nullInput,document.createTextNode(' Match null'));root.appendChild(fieldLabel);if(rangeFields.size){const comparison=document.createElement('label'),operator=document.createElement('select'),option=document.createElement('option');comparison.textContent='Comparison';option.textContent='Equals';operator.appendChild(option);operator.disabled=true;comparison.appendChild(operator);root.appendChild(comparison);}root.append(valueLabel,nullLabel);if(multipleFilters){const add=document.createElement('button');add.type='button';add.textContent='Add filter';add.disabled=true;root.appendChild(add);}}const browse=document.createElement('button'),next=document.createElement('button');browse.type='button';browse.textContent='Browse records';browse.disabled=true;next.type='button';next.textContent='Next page';next.disabled=true;root.append(browse,next);}root.append(idLabel,load);if(schema){const groups=(schema.groups??[]).map(group=>groupControl(document,group,undefined));for(const item of groups){disableGroup(item,true);if(!item.required||item.nullable||item.description)root.appendChild(item.wrapper);}for(const field of schema){const item=fieldControl(document,field);linkGroupHelp(item,groups);item.control.disabled=true;item.setDisabled?.(true);item.refresh?.();for(const child of item.control.querySelectorAll('button,input,select'))child.disabled=true;root.appendChild(item.wrapper??item.control.parentElement);}}else root.appendChild(valueLabel);root.append(save,status);return root;
  };
  return {render,validate};
}
`;
