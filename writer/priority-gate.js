'use strict';
class PriorityGate {
 constructor(){this.mode=null;this.active=null;this.pendingReports=0;}
 async write(work){this.pendingReports++;try{
  if(this.active){this.active.controller.abort();await this.active.done;}
  if(this.mode)return {status:'failed',error:'writer_busy',records:[]};
  this.mode='report';try{return await work();}finally{this.mode=null;}
 }finally{this.pendingReports--;}}
 async research(work){
  if(this.pendingReports||this.mode)return {status:'skipped',error:'writer_busy',records:[],audit:{model_calls:0}};
  const controller=new AbortController();this.mode='research';
  const done=Promise.resolve().then(()=>work(controller.signal)).finally(()=>{this.mode=null;this.active=null;});
  this.active={controller,done};return done;
 }
}
module.exports={PriorityGate};
