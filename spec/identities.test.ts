import {afterEach, describe, expect, it, vi} from 'vitest';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {loadConfig} from '../worker/config';
import {ensureSchema} from '../worker/store/schema';
import {getMessage, listMessages, receiveEmail, sendMessage} from '../worker/services/mail';
import {archiveReplyContext, openArchiveReply, sealArchiveReply} from '../worker/services/archive-links';
import {localProvider} from '../worker/providers/local';
import type {Env, IncomingEmail, MailConfig} from '../worker/types';

const company = {appOrigin:'http://127.0.0.1:8788',mailbox:{id:'main',address:'contacto@company.example',name:'Empresa'},
  identities:[{email:'ventas@company.example',name:'Ventas'},{email:'admin@company.example',name:'Administración'}],
  archiveAddress:'archive@example.net',allowedUsers:['owner@example.net'],storageProvider:'turso'};
const config = () => loadConfig({APP_ENV:'local',COMPANY_CONFIG:JSON.stringify(company)} as Env);
const identity = {email:'owner@example.net',mailboxIds:['main']};
let mf: Miniflare | undefined;
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();mf=undefined;});

async function setup() {
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']}));
  const db=await mf.getD1Database('DB');
  const objects=new Map<string,Uint8Array>();
  const store={
    async put(key:string,value:any){objects.set(key,new Uint8Array(await new Response(value).arrayBuffer()));},
    async get(key:string){const value=objects.get(key);return value?{body:new Response(value).body,text:async()=>new TextDecoder().decode(value)}:null;},
    async delete(key:string){objects.delete(key);},
  };
  const env={DB:db,MAIL:store,ASSETS:{}} as unknown as Env;
  await ensureSchema(db as unknown as D1Database);
  return {db,env,objects};
}
function incoming(to='ventas@company.example') {
  // The visible To header differs from the envelope recipient (a BCC delivery).
  const headers=new Headers({from:'client@example.net',to:'external@example.net',subject:'Consulta','message-id':'<original@example.net>'});
  const bytes=new TextEncoder().encode('From: client@example.net\r\nTo: external@example.net\r\n\r\nConsulta');
  return {from:'client@example.net',to,headers,raw:new Response(bytes).body!,rawSize:bytes.length,forward:vi.fn(async()=>undefined),setReject:vi.fn()} satisfies IncomingEmail;
}

describe('configured sender identities',()=>{
  it('keeps the existing primary identity and validates aliases independently of login',()=>{
    expect(config().identities?.map(x=>x.email)).toEqual(['contacto@company.example','ventas@company.example','admin@company.example']);
    for(const aliases of [[{email:'archive@example.net'}],[{email:'ventas@company.example'},{email:'VENTAS@company.example'}],[{email:'bad\r\n@example.net'}]]) {
      expect(()=>loadConfig({APP_ENV:'local',COMPANY_CONFIG:JSON.stringify({...company,identities:aliases})} as Env)).toThrow();
    }
    expect(loadConfig({APP_ENV:'local',COMPANY_CONFIG:JSON.stringify({...company,identities:undefined})} as Env).identities).toHaveLength(1);
  });

  it('records the real envelope identity, filters SQL pages and rejects unconfigured recipients',async()=>{
    const {env,db}=await setup();const cfg=config();
    await receiveEmail(env,cfg,incoming());await receiveEmail(env,cfg,incoming('admin@company.example'));
    const all=await listMessages(env,cfg,identity,'inbox');expect(all.items).toHaveLength(2);
    const sales=await listMessages(env,cfg,identity,'inbox',undefined,false,'ventas@company.example');
    expect(sales.items).toHaveLength(1);expect(sales.items[0].identityAddress).toBe('ventas@company.example');
    expect((await getMessage(env,cfg,identity,sales.items[0].id)).identityAddress).toBe('ventas@company.example');
    const bad=incoming('unconfigured@company.example');await receiveEmail(env,cfg,bad);expect(bad.setReject).toHaveBeenCalled();expect(bad.forward).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT count(*) AS n FROM mail_message_identities').first<{n:number}>())?.n).toBe(2);
    await expect(listMessages(env,cfg,identity,'inbox',undefined,false,'other@example.net')).rejects.toMatchObject({code:'sender_forbidden'});
  });

  it('uses the recipient identity for replies, prevents spoofing and binds idempotency to From',async()=>{
    const {env,db}=await setup();const cfg=config();const provider=vi.spyOn(localProvider,'send');
    await receiveEmail(env,cfg,incoming());const original=(await listMessages(env,cfg,identity,'inbox')).items[0];
    const input={to:['client@example.net'],subject:'Respuesta',text:'Hola',replyToMessageId:original.id};
    const sent=await sendMessage(env,cfg,identity,input,'reply-identity-key-01');
    expect(provider.mock.calls[0][2].from.email).toBe('ventas@company.example');
    expect((await getMessage(env,cfg,identity,sent.id)).identityAddress).toBe('ventas@company.example');
    expect((await listMessages(env,cfg,identity,'sent',undefined,false,'ventas@company.example')).items).toHaveLength(1);
    await expect(sendMessage(env,cfg,identity,{...input,from:'admin@company.example'},'reply-identity-key-01')).rejects.toMatchObject({code:'idempotency_mismatch'});
    await expect(sendMessage(env,cfg,identity,{...input,from:'attacker@example.net'},'spoof-identity-key-01')).rejects.toMatchObject({code:'sender_forbidden'});
    expect(provider).toHaveBeenCalledTimes(1);
    await sendMessage(env,cfg,identity,{...input,from:'admin@company.example'},'other-identity-key-01');
    expect(provider.mock.calls[1][2].from.email).toBe('admin@company.example');
    // An outgoing snapshot has no invented transport Message-ID. It can still
    // be followed up from its original identity without sending to ourselves.
    await sendMessage(env,cfg,identity,{...input,replyToMessageId:sent.id},'sent-followup-key-01');
    expect(provider.mock.calls[2][2].from.email).toBe('ventas@company.example');
    expect(provider.mock.calls[2][2].to.some(recipient=>recipient.email==='client@example.net')).toBe(true);
    const archiveToken=await sealArchiveReply(env,cfg,{direction:'incoming',from:'admin@company.example',to:['client@example.net'],cc:[],subject:'Consulta',references:[]});
    await db.prepare('DELETE FROM mail_messages WHERE id = ?').bind(original.id).run();
    await sendMessage(env,cfg,identity,{to:['client@example.net'],subject:'Respuesta desde archivo',text:'Hola',archiveReplyToken:archiveToken},'archive-followup-key-01');
    expect(provider.mock.calls[3][2].from.email).toBe('admin@company.example');
  });

  it('keeps the sender in encrypted Gmail reply links after the message cache is gone',async()=>{
    const cfg=config();const env={} as Env;
    const data={direction:'incoming' as const,from:'ventas@company.example',to:['client@example.net'],cc:[],subject:'Consulta',references:[]};
    const token=await sealArchiveReply(env,cfg,data);
    expect(token).not.toContain('ventas');expect((await openArchiveReply(env,cfg,token)).from).toBe(data.from);
    expect((await archiveReplyContext(env,cfg,token)).from).toBe(data.from);
    const removed={...cfg,identities:[{email:cfg.mailbox.address,name:cfg.mailbox.name}]} satisfies MailConfig;
    expect((await archiveReplyContext(env,removed,token)).from).toBe(cfg.mailbox.address);
  });
});
