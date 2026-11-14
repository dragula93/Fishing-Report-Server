'use strict';
const deliveryUpdates=typeof validUpdateDelivery==='function'?null:require('./updates');
function validEmail(address){return typeof address==='string'&&/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(address)&&address.length<255&&!/[\r\n]/.test(address);}
function deliveryItems(loaded) {
 const {input,archive,config}=loaded;
 if(!input||input.schema_version!=='1.0'||!input.run_id||input.location_id!==archive.location_id||input.report_id!==archive.report_id)throw new Error('Invalid archived delivery contract');
 if(['dry_run','render_only'].includes(input.mode))return [{...input,no_send:true,outcome:'dry_run_archived'}];
 if(!['send_test','production','retry_failed_deliveries'].includes(input.mode))throw new Error('Unknown delivery mode');
 if(config.email.smtp_ready!==true)return [{...input,no_send:true,outcome:'smtp_configuration_required'}];
 if(input.namespace!==archive.namespace)throw new Error('Delivery namespace mismatch');
 const checkUpdate=typeof validUpdateDelivery==='function'?validUpdateDelivery:deliveryUpdates.validUpdateDelivery;
 if(!checkUpdate(loaded))return [{...input,no_send:true,outcome:'update_suppressed'}];
 if(['delivery_failed','deferred'].includes(loaded.evaluation?.status)&&input.mode!=='retry_failed_deliveries')return [{...input,no_send:true,outcome:'update_requires_failed_retry'}];
 if(input.namespace==='production'&&(!config.configuration_ready||archive.report.fixture))throw new Error('Production delivery gated');
 if(input.mode==='production'&&archive.namespace!=='production')throw new Error('Production namespace required');
 if(!validEmail(config.email.sender))throw new Error('Invalid configured sender');
 if(!archive.report.effective_subject&&config.email.report_subject!==undefined&&(typeof config.email.report_subject!=='string'||!config.email.report_subject.trim()||config.email.report_subject.length>200||/[\r\n]/.test(config.email.report_subject)))throw new Error('Invalid configured report subject');
 let recipients;
 if(input.mode==='send_test') {if(input.namespace!=='test'||!validEmail(config.execution.test_recipient))throw new Error('Test recipient missing');recipients=[config.execution.test_recipient];}
 else if(input.mode==='retry_failed_deliveries')recipients=loaded.failed_recipients||[];
 else recipients=(loaded.subscribers||[]).filter(s=>s.enabled&&s.locations.includes(archive.location_id)).map(s=>s.email);
 recipients=[...new Set(recipients.map(s=>s.toLowerCase()))];
 if(recipients.some(s=>!validEmail(s)))throw new Error('Invalid subscriber email');
 if(!recipients.length)return [{...input,no_send:true,outcome:'no_recipients'}];
 // New archives own their effective subject. Legacy archives retain the previous
 // configured-base/date behavior; the deliberate test marker always survives.
 let subject=archive.report.effective_subject||archive.subject;
 if(!archive.report.effective_subject&&config.email.report_subject){
  const compose=typeof composeSubject==='function'?composeSubject:deliveryUpdates.composeSubject;
  subject=compose({...archive.report,namespace:archive.namespace},config);
 }
 if(input.mode==='send_test'&&!subject.startsWith('[TEST] '))subject='[TEST] '+subject;
 if(typeof subject!=='string'||!subject.trim()||subject.length>300||/[\r\n]/.test(subject))throw new Error('Invalid archived subject');
 return recipients.map(recipient=>({...input,recipient,sender:config.email.sender,html:archive.html,text:archive.plain_text,subject,message_id:null,no_send:false}));
}
function smtpOutcome(response,context) {
 const r=response||{};const err=r.error;
 if(err) {
  const text=typeof err==='string'?err:JSON.stringify(err);
  // A connection port such as 465 is not an SMTP rejection. Require an
  // explicit response code or a server reply carrying an enhanced status.
  const reply=/\b([45]\d\d)\s+[45]\.\d{1,3}\.\d{1,3}\b/.exec(text);
  const explicit=/response(?:\s*code)?["\s:=]+([45]\d\d)\b/i.exec(text);
  const code=Number(err.responseCode??reply?.[1]??explicit?.[1]);
  const known=code>=400&&code<600;
  return {...context,status:known?'failed':'unknown',diagnostic:{error:text.slice(0,1200),response_code:Number.isFinite(code)?code:null},message_id:null};
 }
 const accepted=(r.accepted||[]).map(s=>String(s).toLowerCase());
 return {...context,status:accepted.includes(context.recipient.toLowerCase())?'accepted':'unknown',message_id:r.messageId||null,diagnostic:{response:r.response||null,accepted:accepted.includes(context.recipient.toLowerCase())}};
}
if(typeof module!=='undefined')module.exports={validEmail,deliveryItems,smtpOutcome};
