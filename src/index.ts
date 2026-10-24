import { DurableObject } from 'cloudflare:workers';
export interface Env { DB:D1Database; ROOM:DurableObjectNamespace; ASSETS:Fetcher }
type User = {id:string;username:string};
const enc = new TextEncoder();
function hex(b:ArrayBuffer|Uint8Array){return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function sha(s:string){return hex(await crypto.subtle.digest('SHA-256',enc.encode(s)))}
async function passwordHash(p:string,salt:string){const k=await crypto.subtle.importKey('raw',enc.encode(p),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},k,256))}
function json(v:unknown,status=200){return Response.json(v,{status,headers:{'Cache-Control':'no-store'}})}
function fail(message:string,status=400){return json({error:message},status)}
async function body(req:Request){try{return await req.json() as Record<string,any>}catch{return {}}}
async function auth(req:Request,env:Env):Promise<User|null>{const t=req.headers.get('authorization')?.replace(/^Bearer /i,'');if(!t)return null;const h=await sha(t);const r=await env.DB.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').bind(h,Date.now()).first<User>();return r??null}
function roomStub(env:Env,id:string){return env.ROOM.get(env.ROOM.idFromName(id))}
export default {async fetch(req:Request,env:Env):Promise<Response>{const url=new URL(req.url),p=url.pathname;if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
try{
 if(p==='/api/register'&&req.method==='POST'){const b=await body(req),name=String(b.username||'').trim(),pw=String(b.password||'');if(!/^[a-zA-Z0-9_\u4e00-\u9fff]{3,20}$/.test(name)||pw.length<8||pw.length>128)return fail('用户名需3-20字符，密码至少8字符');const salt=crypto.randomUUID(),hash=await passwordHash(pw,salt),id=crypto.randomUUID();try{await env.DB.prepare('INSERT INTO users(id,username,salt,password_hash) VALUES(?,?,?,?)').bind(id,name,salt,hash).run()}catch{return fail('用户名已存在',409)}return json({ok:true})}
 if(p==='/api/login'&&req.method==='POST'){const b=await body(req);const u=await env.DB.prepare('SELECT id,username,salt,password_hash FROM users WHERE username=?').bind(String(b.username||'')).first<User&{salt:string;password_hash:string}>();if(!u||await passwordHash(String(b.password||''),u.salt)!==u.password_hash)return fail('账号或密码错误',401);const token=crypto.randomUUID()+crypto.randomUUID();await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha(token),u.id,Date.now()+7*86400000).run();return json({token,user:{id:u.id,username:u.username}})}
 const m=p.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(join|ws)$/);
 if(m){const code=m[1],r=await env.DB.prepare('SELECT room_id FROM rooms WHERE code=?').bind(code).first<{room_id:string}>();if(!r)return fail('房间不存在',404);const stub=roomStub(env,r.room_id);
  if(m[2]==='join'){if(req.method!=='POST')return fail('方法不支持',405);const user=await auth(req,env);if(!user)return fail('请先登录',401);return stub.fetch(new Request('https://room/join',{method:'POST',body:JSON.stringify({user})}))}
  if(m[2]==='ws'){if(!(req.headers.get('Upgrade')||'').toLowerCase().includes('websocket'))return fail('需要 WebSocket 连接',400);const token=url.searchParams.get('token');if(!token)return fail('未登录',401);const session=await auth(new Request(req.url,{headers:{authorization:`Bearer ${token}`}}),env);if(!session)return fail('登录过期',401);return stub.fetch(new Request('https://room/ws',{headers:{Upgrade:'websocket','x-user-id':session.id,'x-username':session.username}}))}}
 const user=await auth(req,env);if(!user)return fail('请先登录',401);
 if(p==='/api/me')return json({user});
 if(p==='/api/logout'&&req.method==='POST'){const t=req.headers.get('authorization')!.replace(/^Bearer /i,'');await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(t)).run();return json({ok:true})}
 if(p==='/api/rooms'&&req.method==='POST'){const b=await body(req);const game=String(b.game||'dice');if(game!=='dice'&&game!=='blackjack')return fail('不支持的玩法',400);const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code='',id='';for(let attempt=0;attempt<6;attempt++){const bytes=crypto.getRandomValues(new Uint8Array(6));code=[...bytes].map(x=>chars[x%chars.length]).join('');id=crypto.randomUUID();try{await env.DB.prepare('INSERT INTO rooms(code,room_id,host_id,game) VALUES(?,?,?,?)').bind(code,id,user.id,game).run();break}catch{code=''}}if(!code)return fail('创建房间失败',500);await roomStub(env,id).fetch(new Request('https://room/init',{method:'POST',body:JSON.stringify({code,host:user,game})}));return json({code,game})}
 return fail('找不到接口',404)
}catch(e){console.error('API error:',e);return fail('服务器处理失败',500)}}} satisfies ExportedHandler<Env>;

// ===== 21点（Blackjack）工具 =====
function freshDeck():number[]{const d:number[]=[];for(let i=0;i<52;i++)d.push(i);for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const t=d[i];d[i]=d[j];d[j]=t}return d}
function cardValue(c:number){const r=c%13;if(r===0)return 11;return r>=10?10:r+1}
function handValue(h:number[]){let v=0,a=0;for(const c of h){v+=cardValue(c);if(c%13===0)a++}while(v>21&&a>0){v-=10;a--}return v}
const CARD_RANKS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'],CARD_SUITS=['♠','♥','♣','♦'];
function cardLabel(c:number){return CARD_RANKS[c%13]+CARD_SUITS[Math.floor(c/13)]}
function cardRed(c:number){return Math.floor(c/13)===1||Math.floor(c/13)===3}

type Player={id:string;name:string;dice:number;roll:number[];ready:boolean;connected:boolean;
 hand:number[];bet:number;chips:number;stand:boolean;bust:boolean};
type State={code:string;hostId:string;game:'dice'|'blackjack';phase:'waiting'|'playing'|'finished';players:Player[];turn:number;bid:{count:number;face:number;by:string}|null;round:number;winnerId:string|null;message:string;
 deck:number[];dealerHand:number[];dealerValue:number;bjPhase:'play'|'dealer'|'settle'|null};
function newPlayer(id:string,name:string):Player{return{id,name,dice:5,roll:[],ready:false,connected:false,hand:[],bet:10,chips:100,stand:false,bust:false}}
export class GameRoom extends DurableObject<Env>{state:State|null=null;constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{this.state=await ctx.storage.get<State>('state')??null})}
 async save(){await this.ctx.storage.put('state',this.state)}
 // 用户当前活跃连接数（Hibernation 下用 getWebSockets + tags 追踪，休眠唤醒后依然有效）
 userConnections(id:string){return this.ctx.getWebSockets().filter(ws=>this.ctx.getTags(ws)[0]===id&&ws.readyState===WebSocket.OPEN).length}
 view(id:string){const s=this.state!;
  if(s.game==='blackjack'){const revealed=s.bjPhase==='dealer'||s.bjPhase==='settle';return{code:s.code,hostId:s.hostId,game:s.game,phase:s.phase,players:s.players.map(p=>({id:p.id,name:p.name,ready:p.ready,connected:p.connected,hand:p.hand.slice(),value:handValue(p.hand),stand:p.stand,bust:p.bust,bet:p.bet,chips:p.chips})),turnPlayerId:s.turn>=0?s.players[s.turn]?.id??null:null,bid:s.bid,round:s.round,winnerId:s.winnerId,message:s.message,dealer:{cards:revealed?s.dealerHand.slice():[s.dealerHand[0]??null,null],value:revealed?s.dealerValue:null,revealed},you:id}}
  return {code:s.code,hostId:s.hostId,game:s.game,phase:s.phase,players:s.players.map(p=>({id:p.id,name:p.name,dice:p.dice,ready:p.ready,connected:p.connected,roll:p.id===id?p.roll:undefined})),turnPlayerId:s.players[s.turn]?.id??null,bid:s.bid,round:s.round,winnerId:s.winnerId,message:s.message,you:id}}
 broadcast(){for(const ws of this.ctx.getWebSockets()){const id=this.ctx.getTags(ws)[0];if(id)try{ws.send(JSON.stringify({type:'state',state:this.view(id)}))}catch{}}}
 async update(){await this.save();this.broadcast()}
 async fetch(req:Request):Promise<Response>{const p=new URL(req.url).pathname;if(p==='/init'){if(this.state)return json({ok:true});const b=await req.json() as {code:string;host:User;game?:string};this.state={code:b.code,hostId:b.host.id,game:b.game==='blackjack'?'blackjack':'dice',phase:'waiting',players:[newPlayer(b.host.id,b.host.username)],turn:0,bid:null,round:0,winnerId:null,message:'等待好友加入',deck:[],dealerHand:[],dealerValue:0,bjPhase:null};await this.save();return json({ok:true})}
 if(!this.state)return fail('房间尚未初始化',404);
 if(p==='/join'){const {user}=await req.json() as {user:User};const s=this.state;let player=s.players.find(x=>x.id===user.id);if(!player){if(s.phase!=='waiting')return fail('游戏已经开始，暂不支持中途加入',409);if(s.players.length>=8)return fail('房间已满',409);s.players.push(newPlayer(user.id,user.username))}await this.update();return json({ok:true})}
 if(p==='/ws'){const id=req.headers.get('x-user-id')!,name=req.headers.get('x-username')!;const player=this.state.players.find(x=>x.id===id);if(!player)return fail('请先加入房间',403);const pair=new WebSocketPair(),client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server,[id]);player.connected=true;await this.update();server.send(JSON.stringify({type:'state',state:this.view(id)}));return new Response(null,{status:101,webSocket:client})}
 return fail('未知请求',404)}
 async webSocketMessage(ws:WebSocket,raw:string|ArrayBuffer){const id=this.ctx.getTags(ws)[0];if(!id||!this.state)return;let msg:any;try{msg=JSON.parse(String(raw))}catch{return}if(msg.type==='ping')return;const s=this.state,p=s.players.find(x=>x.id===id);if(!p)return;const error=(message:string)=>ws.send(JSON.stringify({type:'error',message}));
 if(s.game==='blackjack'){return this.bjMessage(ws,id,msg,error)}
 if(msg.type==='ready'&&s.phase==='waiting'){p.ready=!!msg.value;await this.update();return}
 if(msg.type==='start'){if(id!==s.hostId||s.phase!=='waiting')return error('只有房主可以开始');if(s.players.length<2||!s.players.every(x=>x.ready))return error('至少2人且所有人都需要准备');s.phase='playing';s.players.forEach(x=>x.dice=5);s.round=0;this.newRound();await this.update();return}
 if(msg.type==='restart'){if(id!==s.hostId||s.phase!=='finished')return error('只有房主可以重新开局');s.phase='waiting';s.players.forEach(x=>{x.dice=5;x.roll=[];x.ready=false});s.bid=null;s.winnerId=null;s.message='等待准备';await this.update();return}
 if(s.phase!=='playing'||s.players[s.turn]?.id!==id)return error('现在不是你的回合');
 if(msg.type==='bid'){const count=Number(msg.count),face=Number(msg.face),prev=s.bid;if(!Number.isInteger(count)||!Number.isInteger(face)||count<1||face<1||face>6||count>s.players.reduce((a,x)=>a+x.dice,0))return error('叫点无效');if(prev&&(count<prev.count||(count===prev.count&&face<=prev.face)))return error('叫点必须提高数量，或数量相同时提高点数');s.bid={count,face,by:id};s.message=`${p.name} 叫 ${count} 个 ${face}`;this.nextTurn();await this.update();return}
 if(msg.type==='challenge'){const b=s.bid;if(!b)return error('尚无人叫点');const actual=s.players.reduce((a,x)=>a+x.roll.filter(v=>v===b.face).length,0),loserId=actual>=b.count?id:b.by,loser=s.players.find(x=>x.id===loserId)!;loser.dice--;const reveal=s.players.map(x=>`${x.name}: ${x.roll.join(',')}`).join(' | ');s.message=`开骰：实际 ${actual} 个 ${b.face}，${loser.name} 失去1颗骰子。${reveal}`;const remaining=s.players.filter(x=>x.dice>0);if(remaining.length===1){s.phase='finished';s.winnerId=remaining[0].id;s.message+=` 🎉 ${remaining[0].name} 获胜！`;s.bid=null;await this.update();return}const nextStarter=s.players.findIndex(x=>x.id===loserId&&x.dice>0);const fallback=s.players.findIndex(x=>x.dice>0);this.newRound(nextStarter>=0?nextStarter:fallback,s.message);await this.update();return}}
 // ===== 21点消息处理 =====
 async bjMessage(ws:WebSocket,id:string,msg:any,error:(m:string)=>void){const s=this.state!;const p=s.players.find(x=>x.id===id);if(!p)return;
  if(msg.type==='ready'&&s.phase==='waiting'){p.ready=!!msg.value;await this.update();return}
  if(msg.type==='bet'&&s.phase==='waiting'){const a=Number(msg.amount);if(!Number.isInteger(a)||a<1||a>100)return error('下注需为1-100的整数');p.bet=a;s.message=`${p.name} 下注 ${a}`;await this.update();return}
  if(msg.type==='start'){if(id!==s.hostId||s.phase!=='waiting')return error('只有房主可以开局');if(!s.players.length)return error('房间为空');this.bjDeal();await this.update();return}
  if(msg.type==='next'){if(id!==s.hostId||s.phase!=='finished')return error('只有房主可以再来一局');this.bjDeal();await this.update();return}
  if(msg.type==='restart'){if(id!==s.hostId||s.phase!=='finished')return error('只有房主可以重置');s.phase='waiting';s.players.forEach(x=>{x.ready=false;x.hand=[];x.stand=false;x.bust=false;x.chips=100;x.bet=10});s.bid=null;s.winnerId=null;s.message='等待准备';s.bjPhase=null;s.dealerHand=[];s.dealerValue=0;await this.update();return}
  if(s.phase!=='playing'||s.bjPhase!=='play')return error('当前不能操作');
  if(s.turn<0||s.players[s.turn]?.id!==id)return error('现在不是你的回合');
  if(msg.type==='hit'){p.hand.push(s.deck.pop()!);if(handValue(p.hand)>21)p.bust=true;this.bjAdvance();await this.update();return}
  if(msg.type==='stand'){p.stand=true;this.bjAdvance();await this.update();return}
  return error('未知操作')}
 // 发牌并进入下注后流程
 bjDeal(){const s=this.state!;s.deck=freshDeck();s.dealerHand=[];s.dealerValue=0;s.bjPhase='play';s.round++;s.phase='playing';for(const p of s.players){p.hand=[];p.stand=false;p.bust=false;p.bet=Math.min(Math.max(p.bet||10,1),100);p.hand.push(s.deck.pop()!,s.deck.pop()!)}s.dealerHand.push(s.deck.pop()!,s.deck.pop()!);s.turn=-1;s.message=`第 ${s.round} 局开始，庄家明牌 ${cardLabel(s.dealerHand[0])}`;this.bjAdvance()}
 // 推进回合：未连接玩家自动停牌；全部结束后进入庄家阶段
 bjAdvance(){const s=this.state!;const n=s.players.length;if(!n)return this.dealerRun();let done=true;for(const p of s.players)if(!p.stand&&!p.bust&&p.hand.length)done=false;if(done)return this.dealerRun();for(let i=0;i<n;i++){s.turn=(s.turn+1)%n;const p=s.players[s.turn];if(!p.hand.length)continue;if(p.stand||p.bust)continue;if(!p.connected){p.stand=true;continue}return}this.dealerRun()}
 // 机器人庄家：自动要牌（<17）并结算
 dealerRun(){const s=this.state!;s.bjPhase='dealer';let guard=0;while(handValue(s.dealerHand)<17&&guard++<25)s.dealerHand.push(s.deck.pop()!);s.dealerValue=handValue(s.dealerHand);const dv=s.dealerValue;const lines:string[]=[];let bestPlayer:Player|null=null,bestGain=-1;for(const p of s.players){if(!p.hand.length)continue;const pv=handValue(p.hand);let res:string,gain:number;if(pv>21){res='爆牌';gain=-p.bet}else if(dv>21){res='庄家爆，你赢';gain=p.bet}else if(pv>dv){res='你赢';gain=p.bet}else if(pv<dv){res='你输';gain=-p.bet}else{res='平局';gain=0}if(p.hand.length===2&&pv===21&&!p.bust){res='黑杰克！';gain=Math.floor(p.bet*1.5)}p.chips+=gain;if(gain>bestGain){bestGain=gain;bestPlayer=p}lines.push(`${p.name} ${res}${gain>=0?'+':''}${gain}（筹码${p.chips}）`)}s.winnerId=bestPlayer&&bestGain>0?bestPlayer.id:null;s.message=`庄家 ${dv} 点 ｜ ${lines.join(' ｜ ')}`;s.phase='finished';s.bjPhase='settle'}
 nextTurn(){const s=this.state!;do{s.turn=(s.turn+1)%s.players.length}while(s.players[s.turn].dice<=0)}
 newRound(start?:number,message?:string){const s=this.state!;s.round++;s.bid=null;s.turn=start??s.players.findIndex(x=>x.dice>0);for(const p of s.players)p.roll=Array.from({length:p.dice},()=>crypto.getRandomValues(new Uint32Array(1))[0]%6+1);s.message=message??`第 ${s.round} 轮开始`}
 async webSocketClose(ws:WebSocket,code:number,reason:string,wasClean:boolean){const id=this.ctx.getTags(ws)[0];if(this.state&&id&&this.userConnections(id)===0){const p=this.state.players.find(x=>x.id===id);if(p)p.connected=false;await this.update()}}
 async webSocketError(ws:WebSocket,error:unknown){await this.webSocketClose(ws,1006,'',false)}
}
