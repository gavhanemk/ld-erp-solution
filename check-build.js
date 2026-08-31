const fs=require('fs'),os=require('os'),path=require('path'),https=require('https')
const st=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.expo','state.json'),'utf8'))
const id=process.argv[2]
const body=JSON.stringify({
  query:'query($id: ID!){ builds { byId(buildId: $id) { status artifacts { buildUrl applicationArchiveUrl } error { message } } } }',
  variables:{id}
})
const r=https.request({hostname:'api.expo.dev',path:'/graphql',method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'expo-session':st.auth.sessionSecret}},
 res=>{let s='';res.on('data',d=>s+=d);res.on('end',()=>{
   try{
     const b=JSON.parse(s).data.builds.byId
     console.log(b.status)
     if(b.artifacts?.applicationArchiveUrl) console.log('APK '+b.artifacts.applicationArchiveUrl)
     if(b.error?.message) console.log('ERR '+b.error.message)
   }catch(e){ console.log('UNKNOWN') }
 })})
r.write(body); r.end()
