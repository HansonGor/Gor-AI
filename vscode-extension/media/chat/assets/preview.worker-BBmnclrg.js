(function(){"use strict";var qe={exports:{}};(function($){(_=>{var I=Object.defineProperty,D=Object.getOwnPropertyDescriptor,Q=Object.getOwnPropertyNames,H=Object.prototype.hasOwnProperty,re=(e,n)=>{for(var r in n)I(e,r,{get:n[r],enumerable:!0})},ie=(e,n,r,a)=>{if(n&&typeof n=="object"||typeof n=="function")for(let g of Q(n))!H.call(e,g)&&g!==r&&I(e,g,{get:()=>n[g],enumerable:!(a=D(n,g))||a.enumerable});return e},ve=e=>ie(I({},"__esModule",{value:!0}),e),q=(e,n,r)=>new Promise((a,g)=>{var y=u=>{try{k(r.next(u))}catch(M){g(M)}},h=u=>{try{k(r.throw(u))}catch(M){g(M)}},k=u=>u.done?a(u.value):Promise.resolve(u.value).then(y,h);k((r=r.apply(e,n)).next())}),ae={};re(ae,{analyzeMetafile:()=>Gt,analyzeMetafileSync:()=>Kt,build:()=>Bt,buildSync:()=>Jt,context:()=>Wt,default:()=>en,formatMessages:()=>qt,formatMessagesSync:()=>Ht,initialize:()=>Qt,stop:()=>Xt,transform:()=>zt,transformSync:()=>Yt,version:()=>Vt}),_.exports=ve(ae);function pe(e){let n=a=>{if(a===null)r.write8(0);else if(typeof a=="boolean")r.write8(1),r.write8(+a);else if(typeof a=="number")r.write8(2),r.write32(a|0);else if(typeof a=="string")r.write8(3),r.write(ce(a));else if(a instanceof Uint8Array)r.write8(4),r.write(a);else if(a instanceof Array){r.write8(5),r.write32(a.length);for(let g of a)n(g)}else{let g=Object.keys(a);r.write8(6),r.write32(g.length);for(let y of g)r.write(ce(y)),n(a[y])}},r=new tt;return r.write32(0),r.write32(e.id<<1|+!e.isRequest),n(e.value),ze(r.buf,r.len-4,0),r.buf.subarray(0,r.len)}function Pt(e){let n=()=>{switch(r.read8()){case 0:return null;case 1:return!!r.read8();case 2:return r.read32();case 3:return _e(r.read());case 4:return r.read();case 5:{let h=r.read32(),k=[];for(let u=0;u<h;u++)k.push(n());return k}case 6:{let h=r.read32(),k={};for(let u=0;u<h;u++)k[_e(r.read())]=n();return k}default:throw new Error("Invalid packet")}},r=new tt(e),a=r.read32(),g=(a&1)===0;a>>>=1;let y=n();if(r.ptr!==e.length)throw new Error("Invalid packet");return{id:a,isRequest:g,value:y}}var tt=class{constructor(e=new Uint8Array(1024)){this.buf=e,this.len=0,this.ptr=0}_write(e){if(this.len+e>this.buf.length){let n=new Uint8Array((this.len+e)*2);n.set(this.buf),this.buf=n}return this.len+=e,this.len-e}write8(e){let n=this._write(1);this.buf[n]=e}write32(e){let n=this._write(4);ze(this.buf,e,n)}write(e){let n=this._write(4+e.length);ze(this.buf,e.length,n),this.buf.set(e,n+4)}_read(e){if(this.ptr+e>this.buf.length)throw new Error("Invalid packet");return this.ptr+=e,this.ptr-e}read8(){return this.buf[this._read(1)]}read32(){return nt(this.buf,this._read(4))}read(){let e=this.read32(),n=new Uint8Array(e),r=this._read(n.length);return n.set(this.buf.subarray(r,r+e)),n}},ce,_e,We;if(typeof TextEncoder<"u"&&typeof TextDecoder<"u"){let e=new TextEncoder,n=new TextDecoder;ce=r=>e.encode(r),_e=r=>n.decode(r),We='new TextEncoder().encode("")'}else if(typeof Buffer<"u")ce=e=>Buffer.from(e),_e=e=>{let{buffer:n,byteOffset:r,byteLength:a}=e;return Buffer.from(n,r,a).toString()},We='Buffer.from("")';else throw new Error("No UTF-8 codec found");if(!(ce("")instanceof Uint8Array))throw new Error(`Invariant violation: "${We} instanceof Uint8Array" is incorrectly false

This indicates that your JavaScript environment is broken. You cannot use
esbuild in this environment because esbuild relies on this invariant. This
is not a problem with esbuild. You need to fix your environment instead.
`);function nt(e,n){return e[n++]|e[n++]<<8|e[n++]<<16|e[n++]<<24}function ze(e,n,r){e[r++]=n,e[r++]=n>>8,e[r++]=n>>16,e[r++]=n>>24}var Z=JSON.stringify,rt="warning",st="silent";function ke(e,n){const r=[];for(const a of e){if(te(a,n),a.indexOf(",")>=0)throw new Error(`Invalid ${n}: ${a}`);r.push(a)}return r.join(",")}var De=()=>null,J=e=>typeof e=="boolean"?null:"a boolean",R=e=>typeof e=="string"?null:"a string",Ae=e=>e instanceof RegExp?null:"a RegExp object",be=e=>typeof e=="number"&&e===(e|0)?null:"an integer",$t=e=>typeof e=="number"&&e===(e|0)&&e>=0&&e<=65535?null:"a valid port number",it=e=>typeof e=="function"?null:"a function",fe=e=>Array.isArray(e)?null:"an array",ee=e=>Array.isArray(e)&&e.every(n=>typeof n=="string")?null:"an array of strings",se=e=>typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"an object",Tt=e=>typeof e=="object"&&e!==null?null:"an array or an object",Rt=e=>e instanceof WebAssembly.Module?null:"a WebAssembly.Module",lt=e=>typeof e=="object"&&!Array.isArray(e)?null:"an object or null",ot=e=>typeof e=="string"||typeof e=="boolean"?null:"a string or a boolean",Ot=e=>typeof e=="string"||typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"a string or an object",at=e=>typeof e=="string"||Array.isArray(e)&&e.every(n=>typeof n=="string")?null:"a string or an array of strings",ct=e=>typeof e=="string"||e instanceof Uint8Array?null:"a string or a Uint8Array",It=e=>typeof e=="string"||e instanceof URL?null:"a string or a URL";function i(e,n,r,a){let g=e[r];if(n[r+""]=!0,g===void 0)return;let y=a(g);if(y!==null)throw new Error(`${Z(r)} must be ${y}`);return g}function K(e,n,r){for(let a in e)if(!(a in n))throw new Error(`Invalid option ${r}: ${Z(a)}`)}function Ct(e){let n=Object.create(null),r=i(e,n,"wasmURL",It),a=i(e,n,"wasmModule",Rt),g=i(e,n,"worker",J);return K(e,n,"in initialize() call"),{wasmURL:r,wasmModule:a,worker:g}}function ut(e){let n;if(e!==void 0){n=Object.create(null);for(let r in e){let a=e[r];if(typeof a=="string"||a===!1)n[r]=a;else throw new Error(`Expected ${Z(r)} in mangle cache to map to either a string or false`)}}return n}function Ue(e,n,r,a,g){let y=i(n,r,"color",J),h=i(n,r,"logLevel",R),k=i(n,r,"logLimit",be);y!==void 0?e.push(`--color=${y}`):a&&e.push("--color=true"),e.push(`--log-level=${h||g}`),e.push(`--log-limit=${k||0}`)}function te(e,n,r){if(typeof e!="string")throw new Error(`Expected value for ${n}${r!==void 0?" "+Z(r):""} to be a string, got ${typeof e} instead`);return e}function ft(e,n,r){let a=i(n,r,"legalComments",R),g=i(n,r,"sourceRoot",R),y=i(n,r,"sourcesContent",J),h=i(n,r,"target",at),k=i(n,r,"format",R),u=i(n,r,"globalName",R),M=i(n,r,"mangleProps",Ae),N=i(n,r,"reserveProps",Ae),C=i(n,r,"mangleQuoted",J),z=i(n,r,"minify",J),A=i(n,r,"minifySyntax",J),V=i(n,r,"minifyWhitespace",J),B=i(n,r,"minifyIdentifiers",J),T=i(n,r,"lineLimit",be),Y=i(n,r,"drop",ee),j=i(n,r,"dropLabels",ee),S=i(n,r,"charset",R),p=i(n,r,"treeShaking",J),f=i(n,r,"ignoreAnnotations",J),s=i(n,r,"jsx",R),o=i(n,r,"jsxFactory",R),d=i(n,r,"jsxFragment",R),b=i(n,r,"jsxImportSource",R),x=i(n,r,"jsxDev",J),c=i(n,r,"jsxSideEffects",J),m=i(n,r,"define",se),t=i(n,r,"logOverride",se),l=i(n,r,"supported",se),w=i(n,r,"pure",ee),v=i(n,r,"keepNames",J),P=i(n,r,"platform",R),U=i(n,r,"tsconfigRaw",Ot),G=i(n,r,"absPaths",ee);if(a&&e.push(`--legal-comments=${a}`),g!==void 0&&e.push(`--source-root=${g}`),y!==void 0&&e.push(`--sources-content=${y}`),h&&e.push(`--target=${ke(Array.isArray(h)?h:[h],"target")}`),k&&e.push(`--format=${k}`),u&&e.push(`--global-name=${u}`),P&&e.push(`--platform=${P}`),U&&e.push(`--tsconfig-raw=${typeof U=="string"?U:JSON.stringify(U)}`),z&&e.push("--minify"),A&&e.push("--minify-syntax"),V&&e.push("--minify-whitespace"),B&&e.push("--minify-identifiers"),T&&e.push(`--line-limit=${T}`),S&&e.push(`--charset=${S}`),p!==void 0&&e.push(`--tree-shaking=${p}`),f&&e.push("--ignore-annotations"),Y)for(let E of Y)e.push(`--drop:${te(E,"drop")}`);if(j&&e.push(`--drop-labels=${ke(j,"drop label")}`),G&&e.push(`--abs-paths=${ke(G,"abs paths")}`),M&&e.push(`--mangle-props=${Fe(M)}`),N&&e.push(`--reserve-props=${Fe(N)}`),C!==void 0&&e.push(`--mangle-quoted=${C}`),s&&e.push(`--jsx=${s}`),o&&e.push(`--jsx-factory=${o}`),d&&e.push(`--jsx-fragment=${d}`),b&&e.push(`--jsx-import-source=${b}`),x&&e.push("--jsx-dev"),c&&e.push("--jsx-side-effects"),m)for(let E in m){if(E.indexOf("=")>=0)throw new Error(`Invalid define: ${E}`);e.push(`--define:${E}=${te(m[E],"define",E)}`)}if(t)for(let E in t){if(E.indexOf("=")>=0)throw new Error(`Invalid log override: ${E}`);e.push(`--log-override:${E}=${te(t[E],"log override",E)}`)}if(l)for(let E in l){if(E.indexOf("=")>=0)throw new Error(`Invalid supported: ${E}`);const W=l[E];if(typeof W!="boolean")throw new Error(`Expected value for supported ${Z(E)} to be a boolean, got ${typeof W} instead`);e.push(`--supported:${E}=${W}`)}if(w)for(let E of w)e.push(`--pure:${te(E,"pure")}`);v&&e.push("--keep-names")}function Dt(e,n,r,a,g){var y;let h=[],k=[],u=Object.create(null),M=null,N=null;Ue(h,n,u,r,a),ft(h,n,u);let C=i(n,u,"sourcemap",ot),z=i(n,u,"bundle",J),A=i(n,u,"splitting",J),V=i(n,u,"preserveSymlinks",J),B=i(n,u,"metafile",J),T=i(n,u,"outfile",R),Y=i(n,u,"outdir",R),j=i(n,u,"outbase",R),S=i(n,u,"tsconfig",R),p=i(n,u,"resolveExtensions",ee),f=i(n,u,"nodePaths",ee),s=i(n,u,"mainFields",ee),o=i(n,u,"conditions",ee),d=i(n,u,"external",ee),b=i(n,u,"packages",R),x=i(n,u,"alias",se),c=i(n,u,"loader",se),m=i(n,u,"outExtension",se),t=i(n,u,"publicPath",R),l=i(n,u,"entryNames",R),w=i(n,u,"chunkNames",R),v=i(n,u,"assetNames",R),P=i(n,u,"inject",ee),U=i(n,u,"banner",se),G=i(n,u,"footer",se),E=i(n,u,"entryPoints",Tt),W=i(n,u,"absWorkingDir",R),L=i(n,u,"stdin",se),F=(y=i(n,u,"write",J))!=null?y:g,ne=i(n,u,"allowOverwrite",J),X=i(n,u,"mangleCache",se);if(u.plugins=!0,K(n,u,`in ${e}() call`),C&&h.push(`--sourcemap${C===!0?"":`=${C}`}`),z&&h.push("--bundle"),ne&&h.push("--allow-overwrite"),A&&h.push("--splitting"),V&&h.push("--preserve-symlinks"),B&&h.push("--metafile"),T&&h.push(`--outfile=${T}`),Y&&h.push(`--outdir=${Y}`),j&&h.push(`--outbase=${j}`),S&&h.push(`--tsconfig=${S}`),b&&h.push(`--packages=${b}`),p&&h.push(`--resolve-extensions=${ke(p,"resolve extension")}`),t&&h.push(`--public-path=${t}`),l&&h.push(`--entry-names=${l}`),w&&h.push(`--chunk-names=${w}`),v&&h.push(`--asset-names=${v}`),s&&h.push(`--main-fields=${ke(s,"main field")}`),o&&h.push(`--conditions=${ke(o,"condition")}`),d)for(let O of d)h.push(`--external:${te(O,"external")}`);if(x)for(let O in x){if(O.indexOf("=")>=0)throw new Error(`Invalid package name in alias: ${O}`);h.push(`--alias:${O}=${te(x[O],"alias",O)}`)}if(U)for(let O in U){if(O.indexOf("=")>=0)throw new Error(`Invalid banner file type: ${O}`);h.push(`--banner:${O}=${te(U[O],"banner",O)}`)}if(G)for(let O in G){if(O.indexOf("=")>=0)throw new Error(`Invalid footer file type: ${O}`);h.push(`--footer:${O}=${te(G[O],"footer",O)}`)}if(P)for(let O of P)h.push(`--inject:${te(O,"inject")}`);if(c)for(let O in c){if(O.indexOf("=")>=0)throw new Error(`Invalid loader extension: ${O}`);h.push(`--loader:${O}=${te(c[O],"loader",O)}`)}if(m)for(let O in m){if(O.indexOf("=")>=0)throw new Error(`Invalid out extension: ${O}`);h.push(`--out-extension:${O}=${te(m[O],"out extension",O)}`)}if(E)if(Array.isArray(E))for(let O=0,me=E.length;O<me;O++){let le=E[O];if(typeof le=="object"&&le!==null){let ue=Object.create(null),ge=i(le,ue,"in",R),oe=i(le,ue,"out",R);if(K(le,ue,"in entry point at index "+O),ge===void 0)throw new Error('Missing property "in" for entry point at index '+O);if(oe===void 0)throw new Error('Missing property "out" for entry point at index '+O);k.push([oe,ge])}else k.push(["",te(le,"entry point at index "+O)])}else for(let O in E)k.push([O,te(E[O],"entry point",O)]);if(L){let O=Object.create(null),me=i(L,O,"contents",ct),le=i(L,O,"resolveDir",R),ue=i(L,O,"sourcefile",R),ge=i(L,O,"loader",R);K(L,O,'in "stdin" object'),ue&&h.push(`--sourcefile=${ue}`),ge&&h.push(`--loader=${ge}`),le&&(N=le),typeof me=="string"?M=ce(me):me instanceof Uint8Array&&(M=me)}let he=[];if(f)for(let O of f)O+="",he.push(O);return{entries:k,flags:h,write:F,stdinContents:M,stdinResolveDir:N,absWorkingDir:W,nodePaths:he,mangleCache:ut(X)}}function At(e,n,r,a){let g=[],y=Object.create(null);Ue(g,n,y,r,a),ft(g,n,y);let h=i(n,y,"sourcemap",ot),k=i(n,y,"sourcefile",R),u=i(n,y,"loader",R),M=i(n,y,"banner",R),N=i(n,y,"footer",R),C=i(n,y,"mangleCache",se);return K(n,y,`in ${e}() call`),h&&g.push(`--sourcemap=${h===!0?"external":h}`),k&&g.push(`--sourcefile=${k}`),u&&g.push(`--loader=${u}`),M&&g.push(`--banner=${M}`),N&&g.push(`--footer=${N}`),{flags:g,mangleCache:ut(C)}}function Ut(e){const n={},r={didClose:!1,reason:""};let a={},g=0,y=0,h=new Uint8Array(16*1024),k=0,u=S=>{let p=k+S.length;if(p>h.length){let s=new Uint8Array(p*2);s.set(h),h=s}h.set(S,k),k+=S.length;let f=0;for(;f+4<=k;){let s=nt(h,f);if(f+4+s>k)break;f+=4,V(h.subarray(f,f+s)),f+=s}f>0&&(h.copyWithin(0,f,k),k-=f)},M=S=>{r.didClose=!0,S&&(r.reason=": "+(S.message||S));const p="The service was stopped"+r.reason;for(let f in a)a[f](p,null);a={}},N=(S,p,f)=>{if(r.didClose)return f("The service is no longer running"+r.reason,null);let s=g++;a[s]=(o,d)=>{try{f(o,d)}finally{S&&S.unref()}},S&&S.ref(),e.writeToStdin(pe({id:s,isRequest:!0,value:p}))},C=(S,p)=>{if(r.didClose)throw new Error("The service is no longer running"+r.reason);e.writeToStdin(pe({id:S,isRequest:!1,value:p}))},z=(S,p)=>q(null,null,function*(){try{if(p.command==="ping"){C(S,{});return}if(typeof p.key=="number"){const f=n[p.key];if(!f)return;const s=f[p.command];if(s){yield s(S,p);return}}throw new Error("Invalid command: "+p.command)}catch(f){const s=[xe(f,e,null,void 0,"")];try{C(S,{errors:s})}catch{}}}),A=!0,V=S=>{if(A){A=!1;let f=String.fromCharCode(...S);if(f!=="0.25.12")throw new Error(`Cannot start service: Host version "0.25.12" does not match binary version ${Z(f)}`);return}let p=Pt(S);if(p.isRequest)z(p.id,p.value);else{let f=a[p.id];delete a[p.id],p.value.error?f(p.value.error,{}):f(null,p.value)}};return{readFromStdout:u,afterClose:M,service:{buildOrContext:({callName:S,refs:p,options:f,isTTY:s,defaultWD:o,callback:d})=>{let b=0;const x=y++,c={},m={ref(){++b===1&&p&&p.ref()},unref(){--b===0&&(delete n[x],p&&p.unref())}};n[x]=c,m.ref(),Mt(S,x,N,C,m,e,c,f,s,o,(t,l)=>{try{d(t,l)}finally{m.unref()}})},transform:({callName:S,refs:p,input:f,options:s,isTTY:o,fs:d,callback:b})=>{const x=dt();let c=m=>{try{if(typeof f!="string"&&!(f instanceof Uint8Array))throw new Error('The input to "transform" must be a string or a Uint8Array');let{flags:t,mangleCache:l}=At(S,s,o,st),w={command:"transform",flags:t,inputFS:m!==null,input:m!==null?ce(m):typeof f=="string"?ce(f):f};l&&(w.mangleCache=l),N(p,w,(v,P)=>{if(v)return b(new Error(v),null);let U=Se(P.errors,x),G=Se(P.warnings,x),E=1,W=()=>{if(--E===0){let L={warnings:G,code:P.code,map:P.map,mangleCache:void 0,legalComments:void 0};"legalComments"in P&&(L.legalComments=P==null?void 0:P.legalComments),P.mangleCache&&(L.mangleCache=P==null?void 0:P.mangleCache),b(null,L)}};if(U.length>0)return b(Pe("Transform failed",U,G),null);P.codeFS&&(E++,d.readFile(P.code,(L,F)=>{L!==null?b(L,null):(P.code=F,W())})),P.mapFS&&(E++,d.readFile(P.map,(L,F)=>{L!==null?b(L,null):(P.map=F,W())})),W()})}catch(t){let l=[];try{Ue(l,s,{},o,st)}catch{}const w=xe(t,e,x,void 0,"");N(p,{command:"error",flags:l,error:w},()=>{w.detail=x.load(w.detail),b(Pe("Transform failed",[w],[]),null)})}};if((typeof f=="string"||f instanceof Uint8Array)&&f.length>1024*1024){let m=c;c=()=>d.writeFile(f,m)}c(null)},formatMessages:({callName:S,refs:p,messages:f,options:s,callback:o})=>{if(!s)throw new Error(`Missing second argument in ${S}() call`);let d={},b=i(s,d,"kind",R),x=i(s,d,"color",J),c=i(s,d,"terminalWidth",be);if(K(s,d,`in ${S}() call`),b===void 0)throw new Error(`Missing "kind" in ${S}() call`);if(b!=="error"&&b!=="warning")throw new Error(`Expected "kind" to be "error" or "warning" in ${S}() call`);let m={command:"format-msgs",messages:de(f,"messages",null,"",c),isWarning:b==="warning"};x!==void 0&&(m.color=x),c!==void 0&&(m.terminalWidth=c),N(p,m,(t,l)=>{if(t)return o(new Error(t),null);o(null,l.messages)})},analyzeMetafile:({callName:S,refs:p,metafile:f,options:s,callback:o})=>{s===void 0&&(s={});let d={},b=i(s,d,"color",J),x=i(s,d,"verbose",J);K(s,d,`in ${S}() call`);let c={command:"analyze-metafile",metafile:f};b!==void 0&&(c.color=b),x!==void 0&&(c.verbose=x),N(p,c,(m,t)=>{if(m)return o(new Error(m),null);o(null,t.result)})}}}}function Mt(e,n,r,a,g,y,h,k,u,M,N){const C=dt(),z=e==="context",A=(T,Y)=>{const j=[];try{Ue(j,k,{},u,rt)}catch{}const S=xe(T,y,C,void 0,Y);r(g,{command:"error",flags:j,error:S},()=>{S.detail=C.load(S.detail),N(Pe(z?"Context failed":"Build failed",[S],[]),null)})};let V;if(typeof k=="object"){const T=k.plugins;if(T!==void 0){if(!Array.isArray(T))return A(new Error('"plugins" must be an array'),"");V=T}}if(V&&V.length>0){if(y.isSync)return A(new Error("Cannot use plugins in synchronous API calls"),"");Nt(n,r,a,g,y,h,k,V,C).then(T=>{if(!T.ok)return A(T.error,T.pluginName);try{B(T.requestPlugins,T.runOnEndCallbacks,T.scheduleOnDisposeCallbacks)}catch(Y){A(Y,"")}},T=>A(T,""));return}try{B(null,(T,Y)=>Y([],[]),()=>{})}catch(T){A(T,"")}function B(T,Y,j){const S=y.hasFS,{entries:p,flags:f,write:s,stdinContents:o,stdinResolveDir:d,absWorkingDir:b,nodePaths:x,mangleCache:c}=Dt(e,k,u,rt,S);if(s&&!y.hasFS)throw new Error('The "write" option is unavailable in this environment');const m={command:"build",key:n,entries:p,flags:f,write:s,stdinContents:o,stdinResolveDir:d,absWorkingDir:b||M,nodePaths:x,context:z};T&&(m.plugins=T),c&&(m.mangleCache=c);const t=(v,P)=>{const U={errors:Se(v.errors,C),warnings:Se(v.warnings,C),outputFiles:void 0,metafile:void 0,mangleCache:void 0},G=U.errors.slice(),E=U.warnings.slice();v.outputFiles&&(U.outputFiles=v.outputFiles.map(Lt)),v.metafile&&(U.metafile=JSON.parse(v.metafile)),v.mangleCache&&(U.mangleCache=v.mangleCache),v.writeToStdout!==void 0&&console.log(_e(v.writeToStdout).replace(/\n$/,"")),Y(U,(W,L)=>{if(G.length>0||W.length>0){const F=Pe("Build failed",G.concat(W),E.concat(L));return P(F,null,W,L)}P(null,U,W,L)})};let l,w;z&&(h["on-end"]=(v,P)=>new Promise(U=>{t(P,(G,E,W,L)=>{const F={errors:W,warnings:L};w&&w(G,E),l=void 0,w=void 0,a(v,F),U()})})),r(g,m,(v,P)=>{if(v)return N(new Error(v),null);if(!z)return t(P,(E,W)=>(j(),N(E,W)));if(P.errors.length>0)return N(Pe("Context failed",P.errors,P.warnings),null);let U=!1;const G={rebuild:()=>(l||(l=new Promise((E,W)=>{let L;w=(ne,X)=>{L||(L=()=>ne?W(ne):E(X))};const F=()=>{r(g,{command:"rebuild",key:n},(X,he)=>{X?W(new Error(X)):L?L():F()})};F()})),l),watch:(E={})=>new Promise((W,L)=>{if(!y.hasFS)throw new Error('Cannot use the "watch" API in this environment');const F={},ne=i(E,F,"delay",be);K(E,F,"in watch() call");const X={command:"watch",key:n};ne&&(X.delay=ne),r(g,X,he=>{he?L(new Error(he)):W(void 0)})}),serve:(E={})=>new Promise((W,L)=>{if(!y.hasFS)throw new Error('Cannot use the "serve" API in this environment');const F={},ne=i(E,F,"port",$t),X=i(E,F,"host",R),he=i(E,F,"servedir",R),O=i(E,F,"keyfile",R),me=i(E,F,"certfile",R),le=i(E,F,"fallback",R),ue=i(E,F,"cors",se),ge=i(E,F,"onRequest",it);K(E,F,"in serve() call");const oe={command:"serve",key:n,onRequest:!!ge};if(ne!==void 0&&(oe.port=ne),X!==void 0&&(oe.host=X),he!==void 0&&(oe.servedir=he),O!==void 0&&(oe.keyfile=O),me!==void 0&&(oe.certfile=me),le!==void 0&&(oe.fallback=le),ue){const Te={},je=i(ue,Te,"origin",at);K(ue,Te,'on "cors" object'),Array.isArray(je)?oe.corsOrigin=je:je!==void 0&&(oe.corsOrigin=[je])}r(g,oe,(Te,je)=>{if(Te)return L(new Error(Te));ge&&(h["serve-request"]=(tn,nn)=>{ge(nn.args),a(tn,{})}),W(je)})}),cancel:()=>new Promise(E=>{if(U)return E();r(g,{command:"cancel",key:n},()=>{E()})}),dispose:()=>new Promise(E=>{if(U)return E();U=!0,r(g,{command:"dispose",key:n},()=>{E(),j(),g.unref()})})};g.ref(),N(null,G)})}}var Nt=(e,n,r,a,g,y,h,k,u)=>q(null,null,function*(){let M=[],N=[],C={},z={},A=[],V=0,B=0,T=[],Y=!1;k=[...k];for(let p of k){let f={};if(typeof p!="object")throw new Error(`Plugin at index ${B} must be an object`);const s=i(p,f,"name",R);if(typeof s!="string"||s==="")throw new Error(`Plugin at index ${B} is missing a name`);try{let o=i(p,f,"setup",it);if(typeof o!="function")throw new Error("Plugin is missing a setup function");K(p,f,`on plugin ${Z(s)}`);let d={name:s,onStart:!1,onEnd:!1,onResolve:[],onLoad:[]};B++;let x=o({initialOptions:h,resolve:(c,m={})=>{if(!Y)throw new Error('Cannot call "resolve" before plugin setup has completed');if(typeof c!="string")throw new Error("The path to resolve must be a string");let t=Object.create(null),l=i(m,t,"pluginName",R),w=i(m,t,"importer",R),v=i(m,t,"namespace",R),P=i(m,t,"resolveDir",R),U=i(m,t,"kind",R),G=i(m,t,"pluginData",De),E=i(m,t,"with",se);return K(m,t,"in resolve() call"),new Promise((W,L)=>{const F={command:"resolve",path:c,key:e,pluginName:s};if(l!=null&&(F.pluginName=l),w!=null&&(F.importer=w),v!=null&&(F.namespace=v),P!=null&&(F.resolveDir=P),U!=null)F.kind=U;else throw new Error('Must specify "kind" when calling "resolve"');G!=null&&(F.pluginData=u.store(G)),E!=null&&(F.with=Ft(E,"with")),n(a,F,(ne,X)=>{ne!==null?L(new Error(ne)):W({errors:Se(X.errors,u),warnings:Se(X.warnings,u),path:X.path,external:X.external,sideEffects:X.sideEffects,namespace:X.namespace,suffix:X.suffix,pluginData:u.load(X.pluginData)})})})},onStart(c){let m='This error came from the "onStart" callback registered here:',t=Me(new Error(m),g,"onStart");M.push({name:s,callback:c,note:t}),d.onStart=!0},onEnd(c){let m='This error came from the "onEnd" callback registered here:',t=Me(new Error(m),g,"onEnd");N.push({name:s,callback:c,note:t}),d.onEnd=!0},onResolve(c,m){let t='This error came from the "onResolve" callback registered here:',l=Me(new Error(t),g,"onResolve"),w={},v=i(c,w,"filter",Ae),P=i(c,w,"namespace",R);if(K(c,w,`in onResolve() call for plugin ${Z(s)}`),v==null)throw new Error("onResolve() call is missing a filter");let U=V++;C[U]={name:s,callback:m,note:l},d.onResolve.push({id:U,filter:Fe(v),namespace:P||""})},onLoad(c,m){let t='This error came from the "onLoad" callback registered here:',l=Me(new Error(t),g,"onLoad"),w={},v=i(c,w,"filter",Ae),P=i(c,w,"namespace",R);if(K(c,w,`in onLoad() call for plugin ${Z(s)}`),v==null)throw new Error("onLoad() call is missing a filter");let U=V++;z[U]={name:s,callback:m,note:l},d.onLoad.push({id:U,filter:Fe(v),namespace:P||""})},onDispose(c){A.push(c)},esbuild:g.esbuild});x&&(yield x),T.push(d)}catch(o){return{ok:!1,error:o,pluginName:s}}}y["on-start"]=(p,f)=>q(null,null,function*(){u.clear();let s={errors:[],warnings:[]};yield Promise.all(M.map(o=>q(null,[o],function*({name:d,callback:b,note:x}){try{let c=yield b();if(c!=null){if(typeof c!="object")throw new Error(`Expected onStart() callback in plugin ${Z(d)} to return an object`);let m={},t=i(c,m,"errors",fe),l=i(c,m,"warnings",fe);K(c,m,`from onStart() callback in plugin ${Z(d)}`),t!=null&&s.errors.push(...de(t,"errors",u,d,void 0)),l!=null&&s.warnings.push(...de(l,"warnings",u,d,void 0))}}catch(c){s.errors.push(xe(c,g,u,x&&x(),d))}}))),r(p,s)}),y["on-resolve"]=(p,f)=>q(null,null,function*(){let s={},o="",d,b;for(let x of f.ids)try{({name:o,callback:d,note:b}=C[x]);let c=yield d({path:f.path,importer:f.importer,namespace:f.namespace,resolveDir:f.resolveDir,kind:f.kind,pluginData:u.load(f.pluginData),with:f.with});if(c!=null){if(typeof c!="object")throw new Error(`Expected onResolve() callback in plugin ${Z(o)} to return an object`);let m={},t=i(c,m,"pluginName",R),l=i(c,m,"path",R),w=i(c,m,"namespace",R),v=i(c,m,"suffix",R),P=i(c,m,"external",J),U=i(c,m,"sideEffects",J),G=i(c,m,"pluginData",De),E=i(c,m,"errors",fe),W=i(c,m,"warnings",fe),L=i(c,m,"watchFiles",ee),F=i(c,m,"watchDirs",ee);K(c,m,`from onResolve() callback in plugin ${Z(o)}`),s.id=x,t!=null&&(s.pluginName=t),l!=null&&(s.path=l),w!=null&&(s.namespace=w),v!=null&&(s.suffix=v),P!=null&&(s.external=P),U!=null&&(s.sideEffects=U),G!=null&&(s.pluginData=u.store(G)),E!=null&&(s.errors=de(E,"errors",u,o,void 0)),W!=null&&(s.warnings=de(W,"warnings",u,o,void 0)),L!=null&&(s.watchFiles=Ne(L,"watchFiles")),F!=null&&(s.watchDirs=Ne(F,"watchDirs"));break}}catch(c){s={id:x,errors:[xe(c,g,u,b&&b(),o)]};break}r(p,s)}),y["on-load"]=(p,f)=>q(null,null,function*(){let s={},o="",d,b;for(let x of f.ids)try{({name:o,callback:d,note:b}=z[x]);let c=yield d({path:f.path,namespace:f.namespace,suffix:f.suffix,pluginData:u.load(f.pluginData),with:f.with});if(c!=null){if(typeof c!="object")throw new Error(`Expected onLoad() callback in plugin ${Z(o)} to return an object`);let m={},t=i(c,m,"pluginName",R),l=i(c,m,"contents",ct),w=i(c,m,"resolveDir",R),v=i(c,m,"pluginData",De),P=i(c,m,"loader",R),U=i(c,m,"errors",fe),G=i(c,m,"warnings",fe),E=i(c,m,"watchFiles",ee),W=i(c,m,"watchDirs",ee);K(c,m,`from onLoad() callback in plugin ${Z(o)}`),s.id=x,t!=null&&(s.pluginName=t),l instanceof Uint8Array?s.contents=l:l!=null&&(s.contents=ce(l)),w!=null&&(s.resolveDir=w),v!=null&&(s.pluginData=u.store(v)),P!=null&&(s.loader=P),U!=null&&(s.errors=de(U,"errors",u,o,void 0)),G!=null&&(s.warnings=de(G,"warnings",u,o,void 0)),E!=null&&(s.watchFiles=Ne(E,"watchFiles")),W!=null&&(s.watchDirs=Ne(W,"watchDirs"));break}}catch(c){s={id:x,errors:[xe(c,g,u,b&&b(),o)]};break}r(p,s)});let j=(p,f)=>f([],[]);N.length>0&&(j=(p,f)=>{q(null,null,function*(){const s=[],o=[];for(const{name:d,callback:b,note:x}of N){let c,m;try{const t=yield b(p);if(t!=null){if(typeof t!="object")throw new Error(`Expected onEnd() callback in plugin ${Z(d)} to return an object`);let l={},w=i(t,l,"errors",fe),v=i(t,l,"warnings",fe);K(t,l,`from onEnd() callback in plugin ${Z(d)}`),w!=null&&(c=de(w,"errors",u,d,void 0)),v!=null&&(m=de(v,"warnings",u,d,void 0))}}catch(t){c=[xe(t,g,u,x&&x(),d)]}if(c){s.push(...c);try{p.errors.push(...c)}catch{}}if(m){o.push(...m);try{p.warnings.push(...m)}catch{}}}f(s,o)})});let S=()=>{for(const p of A)setTimeout(()=>p(),0)};return Y=!0,{ok:!0,requestPlugins:T,runOnEndCallbacks:j,scheduleOnDisposeCallbacks:S}});function dt(){const e=new Map;let n=0;return{clear(){e.clear()},load(r){return e.get(r)},store(r){if(r===void 0)return-1;const a=n++;return e.set(a,r),a}}}function Me(e,n,r){let a,g=!1;return()=>{if(g)return a;g=!0;try{let y=(e.stack+"").split(`
`);y.splice(1,1);let h=ht(n,y,r);if(h)return a={text:e.message,location:h},a}catch{}}}function xe(e,n,r,a,g){let y="Internal error",h=null;try{y=(e&&e.message||e)+""}catch{}try{h=ht(n,(e.stack+"").split(`
`),"")}catch{}return{id:"",pluginName:g,text:y,location:h,notes:a?[a]:[],detail:r?r.store(e):-1}}function ht(e,n,r){let a="    at ";if(e.readFileSync&&!n[0].startsWith(a)&&n[1].startsWith(a))for(let g=1;g<n.length;g++){let y=n[g];if(y.startsWith(a))for(y=y.slice(a.length);;){let h=/^(?:new |async )?\S+ \((.*)\)$/.exec(y);if(h){y=h[1];continue}if(h=/^eval at \S+ \((.*)\)(?:, \S+:\d+:\d+)?$/.exec(y),h){y=h[1];continue}if(h=/^(\S+):(\d+):(\d+)$/.exec(y),h){let k;try{k=e.readFileSync(h[1],"utf8")}catch{break}let u=k.split(/\r\n|\r|\n|\u2028|\u2029/)[+h[2]-1]||"",M=+h[3]-1,N=u.slice(M,M+r.length)===r?r.length:0;return{file:h[1],namespace:"file",line:+h[2],column:ce(u.slice(0,M)).length,length:ce(u.slice(M,M+N)).length,lineText:u+`
`+n.slice(1).join(`
`),suggestion:""}}break}}return null}function Pe(e,n,r){let a=5;e+=n.length<1?"":` with ${n.length} error${n.length<2?"":"s"}:`+n.slice(0,a+1).map((y,h)=>{if(h===a)return`
...`;if(!y.location)return`
error: ${y.text}`;let{file:k,line:u,column:M}=y.location,N=y.pluginName?`[plugin: ${y.pluginName}] `:"";return`
${k}:${u}:${M}: ERROR: ${N}${y.text}`}).join("");let g=new Error(e);for(const[y,h]of[["errors",n],["warnings",r]])Object.defineProperty(g,y,{configurable:!0,enumerable:!0,get:()=>h,set:k=>Object.defineProperty(g,y,{configurable:!0,enumerable:!0,value:k})});return g}function Se(e,n){for(const r of e)r.detail=n.load(r.detail);return e}function mt(e,n,r){if(e==null)return null;let a={},g=i(e,a,"file",R),y=i(e,a,"namespace",R),h=i(e,a,"line",be),k=i(e,a,"column",be),u=i(e,a,"length",be),M=i(e,a,"lineText",R),N=i(e,a,"suggestion",R);if(K(e,a,n),M){const C=M.slice(0,(k&&k>0?k:0)+(u&&u>0?u:0)+(r&&r>0?r:80));!/[\x7F-\uFFFF]/.test(C)&&!/\n/.test(M)&&(M=C)}return{file:g||"",namespace:y||"",line:h||0,column:k||0,length:u||0,lineText:M||"",suggestion:N||""}}function de(e,n,r,a,g){let y=[],h=0;for(const k of e){let u={},M=i(k,u,"id",R),N=i(k,u,"pluginName",R),C=i(k,u,"text",R),z=i(k,u,"location",lt),A=i(k,u,"notes",fe),V=i(k,u,"detail",De),B=`in element ${h} of "${n}"`;K(k,u,B);let T=[];if(A)for(const Y of A){let j={},S=i(Y,j,"text",R),p=i(Y,j,"location",lt);K(Y,j,B),T.push({text:S||"",location:mt(p,B,g)})}y.push({id:M||"",pluginName:N||a,text:C||"",location:mt(z,B,g),notes:T,detail:r?r.store(V):-1}),h++}return y}function Ne(e,n){const r=[];for(const a of e){if(typeof a!="string")throw new Error(`${Z(n)} must be an array of strings`);r.push(a)}return r}function Ft(e,n){const r=Object.create(null);for(const a in e){const g=e[a];if(typeof g!="string")throw new Error(`key ${Z(a)} in object ${Z(n)} must be a string`);r[a]=g}return r}function Lt({path:e,contents:n,hash:r}){let a=null;return{path:e,contents:n,hash:r,get text(){const g=this.contents;return(a===null||g!==n)&&(n=g,a=_e(g)),a}}}function Fe(e){let n=e.source;return e.flags&&(n=`(?${e.flags})${n}`),n}var Vt="0.25.12",Bt=e=>$e().build(e),Wt=e=>$e().context(e),zt=(e,n)=>$e().transform(e,n),qt=(e,n)=>$e().formatMessages(e,n),Gt=(e,n)=>$e().analyzeMetafile(e,n),Jt=()=>{throw new Error('The "buildSync" API only works in node')},Yt=()=>{throw new Error('The "transformSync" API only works in node')},Ht=()=>{throw new Error('The "formatMessagesSync" API only works in node')},Kt=()=>{throw new Error('The "analyzeMetafileSync" API only works in node')},Xt=()=>(Le&&Le(),Promise.resolve()),Ee,Le,Ve,$e=()=>{if(Ve)return Ve;throw Ee?new Error('You need to wait for the promise returned from "initialize" to be resolved before calling this'):new Error('You need to call "initialize" before calling this')},Qt=e=>{e=Ct(e||{});let n=e.wasmURL,r=e.wasmModule,a=e.worker!==!1;if(!n&&!r)throw new Error('Must provide either the "wasmURL" option or the "wasmModule" option');if(Ee)throw new Error('Cannot call "initialize" more than once');return Ee=Zt(n||"",r,a),Ee.catch(()=>{Ee=void 0}),Ee},Zt=(e,n,r)=>q(null,null,function*(){let a,g;const y=new Promise(C=>g=C);if(r){let C=new Blob([`onmessage=((postMessage) => {
      // Copyright 2018 The Go Authors. All rights reserved.
      // Use of this source code is governed by a BSD-style
      // license that can be found in the LICENSE file.
      var __async = (__this, __arguments, generator) => {
        return new Promise((resolve, reject) => {
          var fulfilled = (value) => {
            try {
              step(generator.next(value));
            } catch (e) {
              reject(e);
            }
          };
          var rejected = (value) => {
            try {
              step(generator.throw(value));
            } catch (e) {
              reject(e);
            }
          };
          var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
          step((generator = generator.apply(__this, __arguments)).next());
        });
      };
      let onmessage;
      let globalThis = {};
      for (let o = self; o; o = Object.getPrototypeOf(o))
        for (let k of Object.getOwnPropertyNames(o))
          if (!(k in globalThis))
            Object.defineProperty(globalThis, k, { get: () => self[k] });
      "use strict";
      (() => {
        const enosys = () => {
          const err = new Error("not implemented");
          err.code = "ENOSYS";
          return err;
        };
        if (!globalThis.fs) {
          let outputBuf = "";
          globalThis.fs = {
            constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
            // unused
            writeSync(fd, buf) {
              outputBuf += decoder.decode(buf);
              const nl = outputBuf.lastIndexOf("\\n");
              if (nl != -1) {
                console.log(outputBuf.substring(0, nl));
                outputBuf = outputBuf.substring(nl + 1);
              }
              return buf.length;
            },
            write(fd, buf, offset, length, position, callback) {
              if (offset !== 0 || length !== buf.length || position !== null) {
                callback(enosys());
                return;
              }
              const n = this.writeSync(fd, buf);
              callback(null, n);
            },
            chmod(path, mode, callback) {
              callback(enosys());
            },
            chown(path, uid, gid, callback) {
              callback(enosys());
            },
            close(fd, callback) {
              callback(enosys());
            },
            fchmod(fd, mode, callback) {
              callback(enosys());
            },
            fchown(fd, uid, gid, callback) {
              callback(enosys());
            },
            fstat(fd, callback) {
              callback(enosys());
            },
            fsync(fd, callback) {
              callback(null);
            },
            ftruncate(fd, length, callback) {
              callback(enosys());
            },
            lchown(path, uid, gid, callback) {
              callback(enosys());
            },
            link(path, link, callback) {
              callback(enosys());
            },
            lstat(path, callback) {
              callback(enosys());
            },
            mkdir(path, perm, callback) {
              callback(enosys());
            },
            open(path, flags, mode, callback) {
              callback(enosys());
            },
            read(fd, buffer, offset, length, position, callback) {
              callback(enosys());
            },
            readdir(path, callback) {
              callback(enosys());
            },
            readlink(path, callback) {
              callback(enosys());
            },
            rename(from, to, callback) {
              callback(enosys());
            },
            rmdir(path, callback) {
              callback(enosys());
            },
            stat(path, callback) {
              callback(enosys());
            },
            symlink(path, link, callback) {
              callback(enosys());
            },
            truncate(path, length, callback) {
              callback(enosys());
            },
            unlink(path, callback) {
              callback(enosys());
            },
            utimes(path, atime, mtime, callback) {
              callback(enosys());
            }
          };
        }
        if (!globalThis.process) {
          globalThis.process = {
            getuid() {
              return -1;
            },
            getgid() {
              return -1;
            },
            geteuid() {
              return -1;
            },
            getegid() {
              return -1;
            },
            getgroups() {
              throw enosys();
            },
            pid: -1,
            ppid: -1,
            umask() {
              throw enosys();
            },
            cwd() {
              throw enosys();
            },
            chdir() {
              throw enosys();
            }
          };
        }
        if (!globalThis.crypto) {
          throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
        }
        if (!globalThis.performance) {
          throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");
        }
        if (!globalThis.TextEncoder) {
          throw new Error("globalThis.TextEncoder is not available, polyfill required");
        }
        if (!globalThis.TextDecoder) {
          throw new Error("globalThis.TextDecoder is not available, polyfill required");
        }
        const encoder = new TextEncoder("utf-8");
        const decoder = new TextDecoder("utf-8");
        globalThis.Go = class {
          constructor() {
            this.argv = ["js"];
            this.env = {};
            this.exit = (code) => {
              if (code !== 0) {
                console.warn("exit code:", code);
              }
            };
            this._exitPromise = new Promise((resolve) => {
              this._resolveExitPromise = resolve;
            });
            this._pendingEvent = null;
            this._scheduledTimeouts = /* @__PURE__ */ new Map();
            this._nextCallbackTimeoutID = 1;
            const setInt64 = (addr, v) => {
              this.mem.setUint32(addr + 0, v, true);
              this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
            };
            const setInt32 = (addr, v) => {
              this.mem.setUint32(addr + 0, v, true);
            };
            const getInt64 = (addr) => {
              const low = this.mem.getUint32(addr + 0, true);
              const high = this.mem.getInt32(addr + 4, true);
              return low + high * 4294967296;
            };
            const loadValue = (addr) => {
              const f = this.mem.getFloat64(addr, true);
              if (f === 0) {
                return void 0;
              }
              if (!isNaN(f)) {
                return f;
              }
              const id = this.mem.getUint32(addr, true);
              return this._values[id];
            };
            const storeValue = (addr, v) => {
              const nanHead = 2146959360;
              if (typeof v === "number" && v !== 0) {
                if (isNaN(v)) {
                  this.mem.setUint32(addr + 4, nanHead, true);
                  this.mem.setUint32(addr, 0, true);
                  return;
                }
                this.mem.setFloat64(addr, v, true);
                return;
              }
              if (v === void 0) {
                this.mem.setFloat64(addr, 0, true);
                return;
              }
              let id = this._ids.get(v);
              if (id === void 0) {
                id = this._idPool.pop();
                if (id === void 0) {
                  id = this._values.length;
                }
                this._values[id] = v;
                this._goRefCounts[id] = 0;
                this._ids.set(v, id);
              }
              this._goRefCounts[id]++;
              let typeFlag = 0;
              switch (typeof v) {
                case "object":
                  if (v !== null) {
                    typeFlag = 1;
                  }
                  break;
                case "string":
                  typeFlag = 2;
                  break;
                case "symbol":
                  typeFlag = 3;
                  break;
                case "function":
                  typeFlag = 4;
                  break;
              }
              this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
              this.mem.setUint32(addr, id, true);
            };
            const loadSlice = (addr) => {
              const array = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              return new Uint8Array(this._inst.exports.mem.buffer, array, len);
            };
            const loadSliceOfValues = (addr) => {
              const array = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              const a = new Array(len);
              for (let i = 0; i < len; i++) {
                a[i] = loadValue(array + i * 8);
              }
              return a;
            };
            const loadString = (addr) => {
              const saddr = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
            };
            const timeOrigin = Date.now() - performance.now();
            this.importObject = {
              _gotest: {
                add: (a, b) => a + b
              },
              gojs: {
                // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
                // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
                // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
                // This changes the SP, thus we have to update the SP used by the imported function.
                // func wasmExit(code int32)
                "runtime.wasmExit": (sp) => {
                  sp >>>= 0;
                  const code = this.mem.getInt32(sp + 8, true);
                  this.exited = true;
                  delete this._inst;
                  delete this._values;
                  delete this._goRefCounts;
                  delete this._ids;
                  delete this._idPool;
                  this.exit(code);
                },
                // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
                "runtime.wasmWrite": (sp) => {
                  sp >>>= 0;
                  const fd = getInt64(sp + 8);
                  const p = getInt64(sp + 16);
                  const n = this.mem.getInt32(sp + 24, true);
                  globalThis.fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
                },
                // func resetMemoryDataView()
                "runtime.resetMemoryDataView": (sp) => {
                  sp >>>= 0;
                  this.mem = new DataView(this._inst.exports.mem.buffer);
                },
                // func nanotime1() int64
                "runtime.nanotime1": (sp) => {
                  sp >>>= 0;
                  setInt64(sp + 8, (timeOrigin + performance.now()) * 1e6);
                },
                // func walltime() (sec int64, nsec int32)
                "runtime.walltime": (sp) => {
                  sp >>>= 0;
                  const msec = (/* @__PURE__ */ new Date()).getTime();
                  setInt64(sp + 8, msec / 1e3);
                  this.mem.setInt32(sp + 16, msec % 1e3 * 1e6, true);
                },
                // func scheduleTimeoutEvent(delay int64) int32
                "runtime.scheduleTimeoutEvent": (sp) => {
                  sp >>>= 0;
                  const id = this._nextCallbackTimeoutID;
                  this._nextCallbackTimeoutID++;
                  this._scheduledTimeouts.set(id, setTimeout(
                    () => {
                      this._resume();
                      while (this._scheduledTimeouts.has(id)) {
                        console.warn("scheduleTimeoutEvent: missed timeout event");
                        this._resume();
                      }
                    },
                    getInt64(sp + 8)
                  ));
                  this.mem.setInt32(sp + 16, id, true);
                },
                // func clearTimeoutEvent(id int32)
                "runtime.clearTimeoutEvent": (sp) => {
                  sp >>>= 0;
                  const id = this.mem.getInt32(sp + 8, true);
                  clearTimeout(this._scheduledTimeouts.get(id));
                  this._scheduledTimeouts.delete(id);
                },
                // func getRandomData(r []byte)
                "runtime.getRandomData": (sp) => {
                  sp >>>= 0;
                  crypto.getRandomValues(loadSlice(sp + 8));
                },
                // func finalizeRef(v ref)
                "syscall/js.finalizeRef": (sp) => {
                  sp >>>= 0;
                  const id = this.mem.getUint32(sp + 8, true);
                  this._goRefCounts[id]--;
                  if (this._goRefCounts[id] === 0) {
                    const v = this._values[id];
                    this._values[id] = null;
                    this._ids.delete(v);
                    this._idPool.push(id);
                  }
                },
                // func stringVal(value string) ref
                "syscall/js.stringVal": (sp) => {
                  sp >>>= 0;
                  storeValue(sp + 24, loadString(sp + 8));
                },
                // func valueGet(v ref, p string) ref
                "syscall/js.valueGet": (sp) => {
                  sp >>>= 0;
                  const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
                  sp = this._inst.exports.getsp() >>> 0;
                  storeValue(sp + 32, result);
                },
                // func valueSet(v ref, p string, x ref)
                "syscall/js.valueSet": (sp) => {
                  sp >>>= 0;
                  Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
                },
                // func valueDelete(v ref, p string)
                "syscall/js.valueDelete": (sp) => {
                  sp >>>= 0;
                  Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
                },
                // func valueIndex(v ref, i int) ref
                "syscall/js.valueIndex": (sp) => {
                  sp >>>= 0;
                  storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
                },
                // valueSetIndex(v ref, i int, x ref)
                "syscall/js.valueSetIndex": (sp) => {
                  sp >>>= 0;
                  Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
                },
                // func valueCall(v ref, m string, args []ref) (ref, bool)
                "syscall/js.valueCall": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const m = Reflect.get(v, loadString(sp + 16));
                    const args = loadSliceOfValues(sp + 32);
                    const result = Reflect.apply(m, v, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 56, result);
                    this.mem.setUint8(sp + 64, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 56, err);
                    this.mem.setUint8(sp + 64, 0);
                  }
                },
                // func valueInvoke(v ref, args []ref) (ref, bool)
                "syscall/js.valueInvoke": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const args = loadSliceOfValues(sp + 16);
                    const result = Reflect.apply(v, void 0, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, result);
                    this.mem.setUint8(sp + 48, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, err);
                    this.mem.setUint8(sp + 48, 0);
                  }
                },
                // func valueNew(v ref, args []ref) (ref, bool)
                "syscall/js.valueNew": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const args = loadSliceOfValues(sp + 16);
                    const result = Reflect.construct(v, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, result);
                    this.mem.setUint8(sp + 48, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, err);
                    this.mem.setUint8(sp + 48, 0);
                  }
                },
                // func valueLength(v ref) int
                "syscall/js.valueLength": (sp) => {
                  sp >>>= 0;
                  setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
                },
                // valuePrepareString(v ref) (ref, int)
                "syscall/js.valuePrepareString": (sp) => {
                  sp >>>= 0;
                  const str = encoder.encode(String(loadValue(sp + 8)));
                  storeValue(sp + 16, str);
                  setInt64(sp + 24, str.length);
                },
                // valueLoadString(v ref, b []byte)
                "syscall/js.valueLoadString": (sp) => {
                  sp >>>= 0;
                  const str = loadValue(sp + 8);
                  loadSlice(sp + 16).set(str);
                },
                // func valueInstanceOf(v ref, t ref) bool
                "syscall/js.valueInstanceOf": (sp) => {
                  sp >>>= 0;
                  this.mem.setUint8(sp + 24, loadValue(sp + 8) instanceof loadValue(sp + 16) ? 1 : 0);
                },
                // func copyBytesToGo(dst []byte, src ref) (int, bool)
                "syscall/js.copyBytesToGo": (sp) => {
                  sp >>>= 0;
                  const dst = loadSlice(sp + 8);
                  const src = loadValue(sp + 32);
                  if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
                    this.mem.setUint8(sp + 48, 0);
                    return;
                  }
                  const toCopy = src.subarray(0, dst.length);
                  dst.set(toCopy);
                  setInt64(sp + 40, toCopy.length);
                  this.mem.setUint8(sp + 48, 1);
                },
                // func copyBytesToJS(dst ref, src []byte) (int, bool)
                "syscall/js.copyBytesToJS": (sp) => {
                  sp >>>= 0;
                  const dst = loadValue(sp + 8);
                  const src = loadSlice(sp + 16);
                  if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
                    this.mem.setUint8(sp + 48, 0);
                    return;
                  }
                  const toCopy = src.subarray(0, dst.length);
                  dst.set(toCopy);
                  setInt64(sp + 40, toCopy.length);
                  this.mem.setUint8(sp + 48, 1);
                },
                "debug": (value) => {
                  console.log(value);
                }
              }
            };
          }
          run(instance) {
            return __async(this, null, function* () {
              if (!(instance instanceof WebAssembly.Instance)) {
                throw new Error("Go.run: WebAssembly.Instance expected");
              }
              this._inst = instance;
              this.mem = new DataView(this._inst.exports.mem.buffer);
              this._values = [
                // JS values that Go currently has references to, indexed by reference id
                NaN,
                0,
                null,
                true,
                false,
                globalThis,
                this
              ];
              this._goRefCounts = new Array(this._values.length).fill(Infinity);
              this._ids = /* @__PURE__ */ new Map([
                // mapping from JS values to reference ids
                [0, 1],
                [null, 2],
                [true, 3],
                [false, 4],
                [globalThis, 5],
                [this, 6]
              ]);
              this._idPool = [];
              this.exited = false;
              let offset = 4096;
              const strPtr = (str) => {
                const ptr = offset;
                const bytes = encoder.encode(str + "\\0");
                new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
                offset += bytes.length;
                if (offset % 8 !== 0) {
                  offset += 8 - offset % 8;
                }
                return ptr;
              };
              const argc = this.argv.length;
              const argvPtrs = [];
              this.argv.forEach((arg) => {
                argvPtrs.push(strPtr(arg));
              });
              argvPtrs.push(0);
              const keys = Object.keys(this.env).sort();
              keys.forEach((key) => {
                argvPtrs.push(strPtr(\`\${key}=\${this.env[key]}\`));
              });
              argvPtrs.push(0);
              const argv = offset;
              argvPtrs.forEach((ptr) => {
                this.mem.setUint32(offset, ptr, true);
                this.mem.setUint32(offset + 4, 0, true);
                offset += 8;
              });
              const wasmMinDataAddr = 4096 + 8192;
              if (offset >= wasmMinDataAddr) {
                throw new Error("total length of command line and environment variables exceeds limit");
              }
              this._inst.exports.run(argc, argv);
              if (this.exited) {
                this._resolveExitPromise();
              }
              yield this._exitPromise;
            });
          }
          _resume() {
            if (this.exited) {
              throw new Error("Go program has already exited");
            }
            this._inst.exports.resume();
            if (this.exited) {
              this._resolveExitPromise();
            }
          }
          _makeFuncWrapper(id) {
            const go = this;
            return function() {
              const event = { id, this: this, args: arguments };
              go._pendingEvent = event;
              go._resume();
              return event.result;
            };
          }
        };
      })();
      onmessage = ({ data: wasm }) => {
        let decoder = new TextDecoder();
        let fs = globalThis.fs;
        let stderr = "";
        fs.writeSync = (fd, buffer) => {
          if (fd === 1) {
            postMessage(buffer);
          } else if (fd === 2) {
            stderr += decoder.decode(buffer);
            let parts = stderr.split("\\n");
            if (parts.length > 1) console.log(parts.slice(0, -1).join("\\n"));
            stderr = parts[parts.length - 1];
          } else {
            throw new Error("Bad write");
          }
          return buffer.length;
        };
        let stdin = [];
        let resumeStdin;
        let stdinPos = 0;
        onmessage = ({ data }) => {
          if (data.length > 0) {
            stdin.push(data);
            if (resumeStdin) resumeStdin();
          }
          return go;
        };
        fs.read = (fd, buffer, offset, length, position, callback) => {
          if (fd !== 0 || offset !== 0 || length !== buffer.length || position !== null) {
            throw new Error("Bad read");
          }
          if (stdin.length === 0) {
            resumeStdin = () => fs.read(fd, buffer, offset, length, position, callback);
            return;
          }
          let first = stdin[0];
          let count = Math.max(0, Math.min(length, first.length - stdinPos));
          buffer.set(first.subarray(stdinPos, stdinPos + count), offset);
          stdinPos += count;
          if (stdinPos === first.length) {
            stdin.shift();
            stdinPos = 0;
          }
          callback(null, count);
        };
        let go = new globalThis.Go();
        go.argv = ["", \`--service=\${"0.25.12"}\`];
        tryToInstantiateModule(wasm, go).then(
          (instance) => {
            postMessage(null);
            go.run(instance);
          },
          (error) => {
            postMessage(error);
          }
        );
        return go;
      };
      function tryToInstantiateModule(wasm, go) {
        return __async(this, null, function* () {
          if (wasm instanceof WebAssembly.Module) {
            return WebAssembly.instantiate(wasm, go.importObject);
          }
          const res = yield fetch(wasm);
          if (!res.ok) throw new Error(\`Failed to download \${JSON.stringify(wasm)}\`);
          if ("instantiateStreaming" in WebAssembly && /^application\\/wasm($|;)/i.test(res.headers.get("Content-Type") || "")) {
            const result2 = yield WebAssembly.instantiateStreaming(res, go.importObject);
            return result2.instance;
          }
          const bytes = yield res.arrayBuffer();
          const result = yield WebAssembly.instantiate(bytes, go.importObject);
          return result.instance;
        });
      }
      return (m) => onmessage(m);
    })(postMessage)`],{type:"text/javascript"});a=new Worker(URL.createObjectURL(C))}else{let C=(A=>{var V=(j,S,p)=>new Promise((f,s)=>{var o=x=>{try{b(p.next(x))}catch(c){s(c)}},d=x=>{try{b(p.throw(x))}catch(c){s(c)}},b=x=>x.done?f(x.value):Promise.resolve(x.value).then(o,d);b((p=p.apply(j,S)).next())});let B,T={};for(let j=self;j;j=Object.getPrototypeOf(j))for(let S of Object.getOwnPropertyNames(j))S in T||Object.defineProperty(T,S,{get:()=>self[S]});(()=>{const j=()=>{const f=new Error("not implemented");return f.code="ENOSYS",f};if(!T.fs){let f="";T.fs={constants:{O_WRONLY:-1,O_RDWR:-1,O_CREAT:-1,O_TRUNC:-1,O_APPEND:-1,O_EXCL:-1},writeSync(s,o){f+=p.decode(o);const d=f.lastIndexOf(`
`);return d!=-1&&(console.log(f.substring(0,d)),f=f.substring(d+1)),o.length},write(s,o,d,b,x,c){if(d!==0||b!==o.length||x!==null){c(j());return}const m=this.writeSync(s,o);c(null,m)},chmod(s,o,d){d(j())},chown(s,o,d,b){b(j())},close(s,o){o(j())},fchmod(s,o,d){d(j())},fchown(s,o,d,b){b(j())},fstat(s,o){o(j())},fsync(s,o){o(null)},ftruncate(s,o,d){d(j())},lchown(s,o,d,b){b(j())},link(s,o,d){d(j())},lstat(s,o){o(j())},mkdir(s,o,d){d(j())},open(s,o,d,b){b(j())},read(s,o,d,b,x,c){c(j())},readdir(s,o){o(j())},readlink(s,o){o(j())},rename(s,o,d){d(j())},rmdir(s,o){o(j())},stat(s,o){o(j())},symlink(s,o,d){d(j())},truncate(s,o,d){d(j())},unlink(s,o){o(j())},utimes(s,o,d,b){b(j())}}}if(T.process||(T.process={getuid(){return-1},getgid(){return-1},geteuid(){return-1},getegid(){return-1},getgroups(){throw j()},pid:-1,ppid:-1,umask(){throw j()},cwd(){throw j()},chdir(){throw j()}}),!T.crypto)throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");if(!T.performance)throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");if(!T.TextEncoder)throw new Error("globalThis.TextEncoder is not available, polyfill required");if(!T.TextDecoder)throw new Error("globalThis.TextDecoder is not available, polyfill required");const S=new TextEncoder("utf-8"),p=new TextDecoder("utf-8");T.Go=class{constructor(){this.argv=["js"],this.env={},this.exit=t=>{t!==0&&console.warn("exit code:",t)},this._exitPromise=new Promise(t=>{this._resolveExitPromise=t}),this._pendingEvent=null,this._scheduledTimeouts=new Map,this._nextCallbackTimeoutID=1;const f=(t,l)=>{this.mem.setUint32(t+0,l,!0),this.mem.setUint32(t+4,Math.floor(l/4294967296),!0)},s=t=>{const l=this.mem.getUint32(t+0,!0),w=this.mem.getInt32(t+4,!0);return l+w*4294967296},o=t=>{const l=this.mem.getFloat64(t,!0);if(l===0)return;if(!isNaN(l))return l;const w=this.mem.getUint32(t,!0);return this._values[w]},d=(t,l)=>{if(typeof l=="number"&&l!==0){if(isNaN(l)){this.mem.setUint32(t+4,2146959360,!0),this.mem.setUint32(t,0,!0);return}this.mem.setFloat64(t,l,!0);return}if(l===void 0){this.mem.setFloat64(t,0,!0);return}let v=this._ids.get(l);v===void 0&&(v=this._idPool.pop(),v===void 0&&(v=this._values.length),this._values[v]=l,this._goRefCounts[v]=0,this._ids.set(l,v)),this._goRefCounts[v]++;let P=0;switch(typeof l){case"object":l!==null&&(P=1);break;case"string":P=2;break;case"symbol":P=3;break;case"function":P=4;break}this.mem.setUint32(t+4,2146959360|P,!0),this.mem.setUint32(t,v,!0)},b=t=>{const l=s(t+0),w=s(t+8);return new Uint8Array(this._inst.exports.mem.buffer,l,w)},x=t=>{const l=s(t+0),w=s(t+8),v=new Array(w);for(let P=0;P<w;P++)v[P]=o(l+P*8);return v},c=t=>{const l=s(t+0),w=s(t+8);return p.decode(new DataView(this._inst.exports.mem.buffer,l,w))},m=Date.now()-performance.now();this.importObject={_gotest:{add:(t,l)=>t+l},gojs:{"runtime.wasmExit":t=>{t>>>=0;const l=this.mem.getInt32(t+8,!0);this.exited=!0,delete this._inst,delete this._values,delete this._goRefCounts,delete this._ids,delete this._idPool,this.exit(l)},"runtime.wasmWrite":t=>{t>>>=0;const l=s(t+8),w=s(t+16),v=this.mem.getInt32(t+24,!0);T.fs.writeSync(l,new Uint8Array(this._inst.exports.mem.buffer,w,v))},"runtime.resetMemoryDataView":t=>{this.mem=new DataView(this._inst.exports.mem.buffer)},"runtime.nanotime1":t=>{t>>>=0,f(t+8,(m+performance.now())*1e6)},"runtime.walltime":t=>{t>>>=0;const l=new Date().getTime();f(t+8,l/1e3),this.mem.setInt32(t+16,l%1e3*1e6,!0)},"runtime.scheduleTimeoutEvent":t=>{t>>>=0;const l=this._nextCallbackTimeoutID;this._nextCallbackTimeoutID++,this._scheduledTimeouts.set(l,setTimeout(()=>{for(this._resume();this._scheduledTimeouts.has(l);)console.warn("scheduleTimeoutEvent: missed timeout event"),this._resume()},s(t+8))),this.mem.setInt32(t+16,l,!0)},"runtime.clearTimeoutEvent":t=>{t>>>=0;const l=this.mem.getInt32(t+8,!0);clearTimeout(this._scheduledTimeouts.get(l)),this._scheduledTimeouts.delete(l)},"runtime.getRandomData":t=>{t>>>=0,crypto.getRandomValues(b(t+8))},"syscall/js.finalizeRef":t=>{t>>>=0;const l=this.mem.getUint32(t+8,!0);if(this._goRefCounts[l]--,this._goRefCounts[l]===0){const w=this._values[l];this._values[l]=null,this._ids.delete(w),this._idPool.push(l)}},"syscall/js.stringVal":t=>{t>>>=0,d(t+24,c(t+8))},"syscall/js.valueGet":t=>{t>>>=0;const l=Reflect.get(o(t+8),c(t+16));t=this._inst.exports.getsp()>>>0,d(t+32,l)},"syscall/js.valueSet":t=>{t>>>=0,Reflect.set(o(t+8),c(t+16),o(t+32))},"syscall/js.valueDelete":t=>{t>>>=0,Reflect.deleteProperty(o(t+8),c(t+16))},"syscall/js.valueIndex":t=>{t>>>=0,d(t+24,Reflect.get(o(t+8),s(t+16)))},"syscall/js.valueSetIndex":t=>{t>>>=0,Reflect.set(o(t+8),s(t+16),o(t+24))},"syscall/js.valueCall":t=>{t>>>=0;try{const l=o(t+8),w=Reflect.get(l,c(t+16)),v=x(t+32),P=Reflect.apply(w,l,v);t=this._inst.exports.getsp()>>>0,d(t+56,P),this.mem.setUint8(t+64,1)}catch(l){t=this._inst.exports.getsp()>>>0,d(t+56,l),this.mem.setUint8(t+64,0)}},"syscall/js.valueInvoke":t=>{t>>>=0;try{const l=o(t+8),w=x(t+16),v=Reflect.apply(l,void 0,w);t=this._inst.exports.getsp()>>>0,d(t+40,v),this.mem.setUint8(t+48,1)}catch(l){t=this._inst.exports.getsp()>>>0,d(t+40,l),this.mem.setUint8(t+48,0)}},"syscall/js.valueNew":t=>{t>>>=0;try{const l=o(t+8),w=x(t+16),v=Reflect.construct(l,w);t=this._inst.exports.getsp()>>>0,d(t+40,v),this.mem.setUint8(t+48,1)}catch(l){t=this._inst.exports.getsp()>>>0,d(t+40,l),this.mem.setUint8(t+48,0)}},"syscall/js.valueLength":t=>{t>>>=0,f(t+16,parseInt(o(t+8).length))},"syscall/js.valuePrepareString":t=>{t>>>=0;const l=S.encode(String(o(t+8)));d(t+16,l),f(t+24,l.length)},"syscall/js.valueLoadString":t=>{t>>>=0;const l=o(t+8);b(t+16).set(l)},"syscall/js.valueInstanceOf":t=>{t>>>=0,this.mem.setUint8(t+24,o(t+8)instanceof o(t+16)?1:0)},"syscall/js.copyBytesToGo":t=>{t>>>=0;const l=b(t+8),w=o(t+32);if(!(w instanceof Uint8Array||w instanceof Uint8ClampedArray)){this.mem.setUint8(t+48,0);return}const v=w.subarray(0,l.length);l.set(v),f(t+40,v.length),this.mem.setUint8(t+48,1)},"syscall/js.copyBytesToJS":t=>{t>>>=0;const l=o(t+8),w=b(t+16);if(!(l instanceof Uint8Array||l instanceof Uint8ClampedArray)){this.mem.setUint8(t+48,0);return}const v=w.subarray(0,l.length);l.set(v),f(t+40,v.length),this.mem.setUint8(t+48,1)},debug:t=>{console.log(t)}}}}run(f){return V(this,null,function*(){if(!(f instanceof WebAssembly.Instance))throw new Error("Go.run: WebAssembly.Instance expected");this._inst=f,this.mem=new DataView(this._inst.exports.mem.buffer),this._values=[NaN,0,null,!0,!1,T,this],this._goRefCounts=new Array(this._values.length).fill(1/0),this._ids=new Map([[0,1],[null,2],[!0,3],[!1,4],[T,5],[this,6]]),this._idPool=[],this.exited=!1;let s=4096;const o=t=>{const l=s,w=S.encode(t+"\0");return new Uint8Array(this.mem.buffer,s,w.length).set(w),s+=w.length,s%8!==0&&(s+=8-s%8),l},d=this.argv.length,b=[];this.argv.forEach(t=>{b.push(o(t))}),b.push(0),Object.keys(this.env).sort().forEach(t=>{b.push(o(`${t}=${this.env[t]}`))}),b.push(0);const c=s;if(b.forEach(t=>{this.mem.setUint32(s,t,!0),this.mem.setUint32(s+4,0,!0),s+=8}),s>=12288)throw new Error("total length of command line and environment variables exceeds limit");this._inst.exports.run(d,c),this.exited&&this._resolveExitPromise(),yield this._exitPromise})}_resume(){if(this.exited)throw new Error("Go program has already exited");this._inst.exports.resume(),this.exited&&this._resolveExitPromise()}_makeFuncWrapper(f){const s=this;return function(){const o={id:f,this:this,args:arguments};return s._pendingEvent=o,s._resume(),o.result}}}})(),B=({data:j})=>{let S=new TextDecoder,p=T.fs,f="";p.writeSync=(x,c)=>{if(x===1)A(c);else if(x===2){f+=S.decode(c);let m=f.split(`
`);m.length>1&&console.log(m.slice(0,-1).join(`
`)),f=m[m.length-1]}else throw new Error("Bad write");return c.length};let s=[],o,d=0;B=({data:x})=>(x.length>0&&(s.push(x),o&&o()),b),p.read=(x,c,m,t,l,w)=>{if(x!==0||m!==0||t!==c.length||l!==null)throw new Error("Bad read");if(s.length===0){o=()=>p.read(x,c,m,t,l,w);return}let v=s[0],P=Math.max(0,Math.min(t,v.length-d));c.set(v.subarray(d,d+P),m),d+=P,d===v.length&&(s.shift(),d=0),w(null,P)};let b=new T.Go;return b.argv=["","--service=0.25.12"],Y(j,b).then(x=>{A(null),b.run(x)},x=>{A(x)}),b};function Y(j,S){return V(this,null,function*(){if(j instanceof WebAssembly.Module)return WebAssembly.instantiate(j,S.importObject);const p=yield fetch(j);if(!p.ok)throw new Error(`Failed to download ${JSON.stringify(j)}`);if("instantiateStreaming"in WebAssembly&&/^application\/wasm($|;)/i.test(p.headers.get("Content-Type")||""))return(yield WebAssembly.instantiateStreaming(p,S.importObject)).instance;const f=yield p.arrayBuffer();return(yield WebAssembly.instantiate(f,S.importObject)).instance})}return j=>B(j)})(A=>a.onmessage({data:A})),z;a={onmessage:null,postMessage:A=>setTimeout(()=>{try{z=C({data:A})}catch(V){g(V)}}),terminate(){if(z)for(let A of z._scheduledTimeouts.values())clearTimeout(A)}}}let h,k;const u=new Promise((C,z)=>{h=C,k=z});a.onmessage=({data:C})=>{a.onmessage=({data:z})=>M(z),C?k(C):h()},a.postMessage(n||new URL(e,location.href).toString());let{readFromStdout:M,service:N}=Ut({writeToStdin(C){a.postMessage(C)},isSync:!1,hasFS:!1,esbuild:ae});yield u,Le=()=>{a.terminate(),Ee=void 0,Le=void 0,Ve=void 0},Ve={build:C=>new Promise((z,A)=>{y.then(A),N.buildOrContext({callName:"build",refs:null,options:C,isTTY:!1,defaultWD:"/",callback:(V,B)=>V?A(V):z(B)})}),context:C=>new Promise((z,A)=>{y.then(A),N.buildOrContext({callName:"context",refs:null,options:C,isTTY:!1,defaultWD:"/",callback:(V,B)=>V?A(V):z(B)})}),transform:(C,z)=>new Promise((A,V)=>{y.then(V),N.transform({callName:"transform",refs:null,input:C,options:z||{},isTTY:!1,fs:{readFile(B,T){T(new Error("Internal error"),null)},writeFile(B,T){T(null)}},callback:(B,T)=>B?V(B):A(T)})}),formatMessages:(C,z)=>new Promise((A,V)=>{y.then(V),N.formatMessages({callName:"formatMessages",refs:null,messages:C,options:z,callback:(B,T)=>B?V(B):A(T)})}),analyzeMetafile:(C,z)=>new Promise((A,V)=>{y.then(V),N.analyzeMetafile({callName:"analyzeMetafile",refs:null,metafile:typeof C=="string"?C:JSON.stringify(C),options:z,callback:(B,T)=>B?V(B):A(T)})})}}),en=ae})($)})(qe);var Ge=qe.exports,gt=""+new URL("esbuild-BHljloGq.wasm",self.location.href).href;const pt="..";function ye($){if(typeof $!="string"||$.includes("\0"))throw new Error("Preview path must be a valid string.");const I=$.trim().replace(/\\/g,"/").split("/");if(I.includes(pt))throw new Error(`Preview path cannot traverse outside the virtual root: ${$}`);const D=I.filter(Q=>Q&&Q!==".");if(D.length===0)throw new Error("Preview path must point to a file below /.");return`/${D.join("/")}`}function yt($,_){const I=$==="/"?"/":ye($),D=_.trim().replace(/\\/g,"/");if(D.startsWith("/"))return ye(D);const Q=I==="/"?[]:I.slice(1).split("/");for(const H of D.split("/"))if(!(!H||H==="."))if(H===".."){if(Q.length===0)throw new Error(`Preview path cannot traverse outside the virtual root: ${_}`);Q.pop()}else Q.push(H);if(Q.length===0)throw new Error("Preview path must point to a file below /.");return ye(`/${Q.join("/")}`)}function Je($){return $.map(_=>{var I,D,Q,H,re;return{message:_.text??_.message??"Unknown build error",file:((D=(I=_.location)==null?void 0:I.file)==null?void 0:D.replace(/^preview-vfs:/,""))||null,line:((Q=_.location)==null?void 0:Q.line)??null,column:((H=_.location)==null?void 0:H.column)===void 0?null:_.location.column+1,lineText:((re=_.location)==null?void 0:re.lineText)||null}})}function wt($){return typeof $=="object"&&$!==null&&"errors"in $&&Array.isArray($.errors)?Je($.errors):[{message:$ instanceof Error?$.message:String($),file:null,line:null,column:null,lineText:null}]}const vt=new Set(["react","react/jsx-runtime","react/jsx-dev-runtime","react-dom","react-dom/client","three"]);function bt($){return!$.startsWith(".")&&!$.startsWith("/")}function xt($){if(!vt.has($))throw new Error(`Dependency "${$}" is not allowed in Preview Project.`);return $}const Be=[".ts",".tsx",".js",".jsx",".css",".json"];function Ye($){const _=$.slice($.lastIndexOf("/")+1),I=_.lastIndexOf(".");return I<0?"":_.slice(I).toLowerCase()}function He($){const _=Ye($);if(_===".ts")return"ts";if(_===".tsx")return"tsx";if(_===".js")return"js";if(_===".jsx")return"jsx";if(_===".css")return"css";if(_===".json")return"json";throw new Error(`Unsupported Preview Project file type: ${_||"(no extension)"} (${$})`)}function Ke($){const _=ye($),I=_.lastIndexOf("/");return I<=0?"/":_.slice(0,I)}function Xe($,_,I="/"){const D=_.startsWith("/")?ye(_):yt(I==="/"?"/":Ke(I),_),re=(Be.includes(Ye(D))?[D]:[D,...Be.map(ie=>`${D}${ie}`),...Be.map(ie=>`${D}/index${ie}`)]).find(ie=>Object.prototype.hasOwnProperty.call($,ie));if(!re)throw new Error(`Cannot resolve "${_}" from "${I}" in Preview Project.`);return re}function Et($){return{name:"preview-virtual-fs",setup(_){_.onResolve({filter:/.*/},I=>{try{return bt(I.path)?{path:xt(I.path),namespace:"preview-runtime-dependency"}:{path:Xe($(),I.path,I.importer||"/"),namespace:"preview-vfs"}}catch(D){return{errors:[{text:D instanceof Error?D.message:String(D)}]}}}),_.onLoad({filter:/.*/,namespace:"preview-vfs"},I=>{try{const D=$()[I.path];return D===void 0?{errors:[{text:`Virtual file not found: ${I.path}`}]}:{contents:D,loader:He(I.path),resolveDir:Ke(I.path)}}catch(D){return{errors:[{text:D instanceof Error?D.message:String(D)}]}}}),_.onLoad({filter:/.*/,namespace:"preview-runtime-dependency"},I=>{const D="globalThis.__GOR_PREVIEW_RUNTIME__",H={three:`module.exports = ${D}.THREE;`,react:`const React = ${D}.React;
export default React;
export const { Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, cloneElement, createContext, createElement, createFactory, createRef, forwardRef, isValidElement, lazy, memo, startTransition, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = React;`,"react-dom":`const ReactDOM = ${D}.ReactDOM;
export default ReactDOM;
export const { createPortal, flushSync, findDOMNode, hydrate, render, unmountComponentAtNode, version } = ReactDOM;`,"react-dom/client":`const ReactDOMClient = ${D}.ReactDOMClient;
export default ReactDOMClient;
export const { createRoot, hydrateRoot, version } = ReactDOMClient;`,"react/jsx-runtime":`const runtime = ${D}.jsxRuntime;
export const { Fragment, jsx, jsxs } = runtime;`,"react/jsx-dev-runtime":`const runtime = ${D}.jsxDevRuntime;
export const { Fragment, jsxDEV } = runtime;`}[I.path];return H?{contents:H,loader:"js"}:{errors:[{text:`Unsupported runtime dependency: ${I.path}`}]}})}}}function Re($,_){var I;return(I=$.match(new RegExp(`(?:^|\\s)${_}\\s*=\\s*["']([^"']*)["']`,"i")))==null?void 0:I[1]}function _t($){const _=$.replace(/<!--[\s\S]*?-->/g,"");return Array.from(_.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi),I=>{var D;return{tag:I[1],source:I[2],type:(D=Re(I[1],"type"))==null?void 0:D.toLowerCase(),src:Re(I[1],"src")}})}const Qe="/__gor_babel_entry__.jsx";function kt($,_){if(_!==Qe)return $;const I={...$},D=($["/index.html"]??"").replace(/<!--[\s\S]*?-->/g,""),Q=_t(D).filter(q=>q.type==="text/babel"||q.type==="text/jsx");if(!Q.length)throw new Error("Preview Babel entry has no JSX scripts.");const H=q=>{if(/^(?:[a-z][\w+.-]*:|\/\/)/i.test(q))throw new Error("Preview Babel scripts and styles must use virtual local files, not external URLs.");return ye(q)},re=(q,ae)=>{if(Object.prototype.hasOwnProperty.call(I,q))throw new Error(`Preview adapter path conflicts with project source: ${q}`);I[q]=ae},ie=Array.from(D.matchAll(/<link\b[^>]*>/gi)).flatMap(([q])=>{var pe;const ae=Re(q,"href");return((pe=Re(q,"rel"))==null?void 0:pe.toLowerCase())==="stylesheet"&&ae?[`import ${JSON.stringify(H(ae))};`]:[]}),ve=Q.map((q,ae)=>{const pe=q.src?H(q.src):`/__gor_babel_inline_${ae}.jsx`;return q.src||re(pe,q.source),`require(${JSON.stringify(pe)});`});return re(Qe,["import React from 'react';","import * as ReactDOM from 'react-dom';","import * as ReactDOMClient from 'react-dom/client';","globalThis.React = React;","globalThis.ReactDOM = { ...ReactDOM, ...ReactDOMClient };",...ie,...ve].join(`
`)),I}let Oe=null;function Ze(){return Oe||(Oe=Ge.initialize({wasmURL:gt,worker:!1}).catch($=>{throw Oe=null,$})),Oe}function St($){if($.endsWith(".js"))return"js";if($.endsWith(".css"))return"css";throw new Error(`Unexpected build output type: ${$}`)}async function jt($,_,I,D){await Ze();const Q=performance.now(),H=ye(D),re=kt(I,H);Xe(re,H),He(H);const ie=await Ge.build({entryPoints:[H],bundle:!0,write:!1,outdir:"/out",entryNames:"bundle",format:"iife",globalName:"__GOR_PREVIEW_BUNDLE__",platform:"browser",jsx:"automatic",sourcemap:!1,logLevel:"silent",plugins:[Et(()=>re)]});return{buildId:_,projectId:$,entryPoint:H,outputFiles:(ie.outputFiles??[]).map(ve=>({path:ve.path.replace(/\\/g,"/"),type:St(ve.path),contents:ve.text})),warnings:Je(ie.warnings),duration:performance.now()-Q}}const et=self;let Ie=null,Ce={};function we($){et.postMessage($)}et.onmessage=async $=>{const _=$.data;try{if(_.type==="INIT"){await Ze(),we({type:"READY",requestId:_.requestId});return}if(_.type==="RESET"){Ie=null,Ce={},we({type:"FILES_SYNCED",requestId:_.requestId,projectId:null,fileCount:0});return}if(_.type==="SYNC_FILES"){Ie=_.projectId,Ce=structuredClone(_.files),we({type:"FILES_SYNCED",requestId:_.requestId,projectId:Ie,fileCount:Object.keys(Ce).length});return}we({type:"BUILD_STARTED",requestId:_.requestId,projectId:_.projectId,buildId:_.buildId});const I=performance.now();if(Ie!==_.projectId)throw new Error(`Preview Project "${_.projectId}" is not synchronized with the compiler Worker.`);try{const D=await jt(_.projectId,_.buildId,Ce,_.entryPoint);we({type:"BUILD_SUCCESS",requestId:_.requestId,result:D})}catch(D){we({type:"BUILD_ERROR",requestId:_.requestId,projectId:_.projectId,buildId:_.buildId,diagnostics:wt(D),duration:performance.now()-I})}}catch(I){we({type:"WORKER_ERROR",requestId:_.requestId,message:I instanceof Error?I.message:String(I)})}}})();
