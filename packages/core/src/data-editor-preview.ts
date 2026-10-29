/** Inert control-plane counterpart to the generated host-owned record editor. */
export const RECORD_EDITOR_PREVIEW = `
export function createRecordEditor({getOperation,putOperation}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation))throw Error('Invalid record editor capabilities');
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
    root.append(heading,idLabel,load,valueLabel,save,status);return root;
  };
  return {render,validate};
}
`;
