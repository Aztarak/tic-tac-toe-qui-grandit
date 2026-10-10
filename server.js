const http=require('http'),fs=require('fs'),path=require('path'),{WebSocketServer}=require('ws');
const PORT=process.env.PORT||3000,MAX=10,SYM=['✕','◯','△','□','◇','★','☾','✚','♥','♣'];
const page=fs.readFileSync(path.join(__dirname,'public','index.html'));
const srv=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(page)});
const wss=new WebSocketServer({server:srv,maxPayload:64*1024});
const rooms=new Map();
const fresh=()=>({size:3,k:3,board:Array(9).fill(''),players:[],turn:0,dir:1,winner:'',line:[],games:0,grown:0,over:'',note:'',tw:null,moves:0,twists:true});

function findLine(b,n,k,i){
  const r=i/n|0,c=i%n,m=b[i];
  for(const[dr,dc]of[[0,1],[1,0],[1,1],[1,-1]]){
    const cells=[i];
    for(const s of[1,-1]){let y=r+dr*s,x=c+dc*s;while(y>=0&&y<n&&x>=0&&x<n&&b[y*n+x]===m){cells.push(y*n+x);y+=dr*s;x+=dc*s}}
    if(cells.length>=k)return cells;
  }
  return null;
}
const anyLine=g=>{for(let i=0;i<g.board.length;i++)if(g.board[i]){const l=findLine(g.board,g.size,g.k,i);if(l)return l}return null};
function step(g,from,count){
  const n=g.players.length;let i=from;
  for(let c=0;c<count;c++){let t=0;do{i=(i+g.dir+n)%n;t++}while(g.players[i].out&&t<=n)}
  return i;
}
function twist(g){
  const occ=[],emp=[];g.board.forEach((v,i)=>(v?occ:emp).push(i));
  const pick=a=>a.splice(Math.random()*a.length|0,1)[0];
  const o=[['🎁','Double tour : le même joueur rejoue !',()=>0],['⏭','Le prochain joueur saute son tour !',()=>2],['🔄','Le sens du jeu s’inverse !',()=>{g.dir*=-1;return 1}]];
  if(occ.length>=4)o.push(['💣','Explosion : 3 symboles disparaissent !',()=>{for(let j=0;j<3;j++)g.board[pick(occ)]='';return 1}],
    ['🌪','Tornade : deux symboles échangent leur place !',()=>{const a=pick(occ),b=pick(occ);[g.board[a],g.board[b]]=[g.board[b],g.board[a]];return 1}],
    ['🌋','Séisme : tous les symboles sont mélangés !',()=>{const v=occ.map(i=>g.board[i]).sort(()=>Math.random()-.5);occ.forEach((i,j)=>g.board[i]=v[j]);return 1}]);
  if(emp.length>=2)o.push(['👻','Un fantôme pose un symbole au hasard !',()=>{const a=g.players.filter(p=>!p.out);g.board[pick(emp)]=a[Math.random()*a.length|0].id;return 1}]);
  const t=o[Math.random()*o.length|0],adv=t[2]();
  g.tw={e:t[0],t:t[1],n:Date.now(),at:g.moves};return adv;
}
function play(g,me,i){
  if(me<0||g.turn!==me||!Number.isInteger(i)||i<0||i>=g.board.length||g.board[i]||g.winner||g.over||g.players.filter(p=>!p.out).length<2)return;
  g.board[i]=g.players[me].id;g.note='';g.moves++;
  let adv=1,line=findLine(g.board,g.size,g.k,i);
  if(!line&&g.twists&&Math.random()<.3){adv=twist(g);line=anyLine(g)}
  if(line){g.winner=g.board[line[0]];g.line=line;g.players.find(p=>p.id===g.winner).wins++}
  else if(g.board.every(Boolean)){
    if(g.size>=MAX)g.over='draw';
    else{const n=g.size+1,nb=Array(n*n).fill('');g.board.forEach((v,j)=>{nb[(j/g.size|0)*n+j%g.size]=v});g.size=n;g.k=n;g.board=nb;g.grown++;g.note=`Égalité ! La grille passe à ${n}×${n} : il faut maintenant aligner ${n} symboles.`;g.turn=step(g,me,adv)}
  }else g.turn=step(g,me,adv);
}
function again(S){
  const g=fresh();g.players=S.players;g.twists=S.twists;g.games=S.games+1;
  g.turn=g.games%g.players.length;if(g.players[g.turn].out)g.turn=step(g,g.turn,1);
  return g;
}

const pub=S=>({...S,players:S.players.map(({pid,...p})=>p)});
const send=(ws,o)=>{if(ws.readyState===1)ws.send(JSON.stringify(o))};
function broadcast(R){const m=JSON.stringify({t:'state',s:pub(R.S)});R.socks.forEach(w=>w.readyState===1&&w.send(m))}

function join(ws,m){
  const code=String(m.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8),pid=String(m.pid||'').replace(/[^\w-]/g,'').slice(0,40);
  if(!code||!pid||ws.room)return;
  let R=rooms.get(code);if(!R){R={S:fresh(),imgs:{},socks:new Set(),timer:null};rooms.set(code,R)}
  clearTimeout(R.timer);R.socks.add(ws);ws.room=code;ws.pid=pid;
  let p=R.S.players.find(p=>p.pid===pid);
  if(p)p.out=false;
  else{const n=R.S.players.length;p={id:'p'+n,pid,name:String(m.name||'Joueur '+(n+1)).slice(0,16),sym:SYM[n%SYM.length],out:false,wins:0};R.S.players.push(p)}
  send(ws,{t:'hello',me:p.id,imgs:R.imgs});broadcast(R);
}
function leave(ws){
  const R=rooms.get(ws.room);if(!R)return;R.socks.delete(ws);
  if(![...R.socks].some(w=>w.pid===ws.pid)){
    const p=R.S.players.find(p=>p.pid===ws.pid);
    if(p){p.out=true;if(R.S.players[R.S.turn].out)R.S.turn=step(R.S,R.S.turn,1)}
    broadcast(R);
  }
  if(!R.socks.size)R.timer=setTimeout(()=>rooms.delete(ws.room),600000);
}
function act(ws,m){
  const R=rooms.get(ws.room);if(!R)return;const S=R.S,me=S.players.findIndex(p=>p.pid===ws.pid);
  if(m.t==='move')play(S,me,+m.i);
  else if(m.t==='again'&&me>=0&&(S.winner||S.over))R.S=again(S);
  else if(m.t==='tw'&&me>=0)S.twists=!!m.v;
  else if(m.t==='img'&&me>=0&&typeof m.img==='string'&&m.img.length<=30000&&(m.img===''||/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+\/=]+$/.test(m.img))){
    const id=S.players[me].id;R.imgs[id]=m.img;
    R.socks.forEach(w=>send(w,{t:'img',id,img:m.img}));return;
  }
  broadcast(R);
}

wss.on('connection',ws=>{
  ws.alive=true;ws.on('pong',()=>{ws.alive=true});
  ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(!m||typeof m!=='object')return;if(m.t==='join')join(ws,m);else if(ws.room)act(ws,m)});
  ws.on('close',()=>leave(ws));
});
setInterval(()=>wss.clients.forEach(w=>{if(!w.alive)return w.terminate();w.alive=false;w.ping()}),30000);
srv.listen(PORT,()=>console.log('Puissance Trois évolutif sur http://localhost:'+PORT));
