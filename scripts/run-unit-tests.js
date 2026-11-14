const {spawnSync}=require('node:child_process');
for(const name of ['core','evidence','freshness','community','community-service','outlook','news','writer','rough-seas','delivery','updates','ocean','ocean-refresh','workflow','portable']){
 const result=spawnSync(process.execPath,['tests/'+name+'.test.js'],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status||1);
}
