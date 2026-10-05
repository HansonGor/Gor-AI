(function(){"use strict";var Be={exports:{}};(function(R){(P=>{var C=Object.defineProperty,D=Object.getOwnPropertyDescriptor,Q=Object.getOwnPropertyNames,X=Object.prototype.hasOwnProperty,oe=(e,n)=>{for(var r in n)C(e,r,{get:n[r],enumerable:!0})},ie=(e,n,r,a)=>{if(n&&typeof n=="object"||typeof n=="function")for(let g of Q(n))!X.call(e,g)&&g!==r&&C(e,g,{get:()=>n[g],enumerable:!(a=D(n,g))||a.enumerable});return e},Et=e=>ie(C({},"__esModule",{value:!0}),e),me=(e,n,r)=>new Promise((a,g)=>{var y=u=>{try{_(r.next(u))}catch(M){g(M)}},h=u=>{try{_(r.throw(u))}catch(M){g(M)}},_=u=>u.done?a(u.value):Promise.resolve(u.value).then(y,h);_((r=r.apply(e,n)).next())}),Oe={};oe(Oe,{analyzeMetafile:()=>Bt,analyzeMetafileSync:()=>Gt,build:()=>Nt,buildSync:()=>Wt,context:()=>Ft,default:()=>Kt,formatMessages:()=>Vt,formatMessagesSync:()=>qt,initialize:()=>Yt,stop:()=>Jt,transform:()=>Lt,transformSync:()=>zt,version:()=>Mt}),P.exports=Et(Oe);function Xe(e){let n=a=>{if(a===null)r.write8(0);else if(typeof a=="boolean")r.write8(1),r.write8(+a);else if(typeof a=="number")r.write8(2),r.write32(a|0);else if(typeof a=="string")r.write8(3),r.write(le(a));else if(a instanceof Uint8Array)r.write8(4),r.write(a);else if(a instanceof Array){r.write8(5),r.write32(a.length);for(let g of a)n(g)}else{let g=Object.keys(a);r.write8(6),r.write32(g.length);for(let y of g)r.write(le(y)),n(a[y])}},r=new Qe;return r.write32(0),r.write32(e.id<<1|+!e.isRequest),n(e.value),Ve(r.buf,r.len-4,0),r.buf.subarray(0,r.len)}function _t(e){let n=()=>{switch(r.read8()){case 0:return null;case 1:return!!r.read8();case 2:return r.read32();case 3:return be(r.read());case 4:return r.read();case 5:{let h=r.read32(),_=[];for(let u=0;u<h;u++)_.push(n());return _}case 6:{let h=r.read32(),_={};for(let u=0;u<h;u++)_[be(r.read())]=n();return _}default:throw new Error("Invalid packet")}},r=new Qe(e),a=r.read32(),g=(a&1)===0;a>>>=1;let y=n();if(r.ptr!==e.length)throw new Error("Invalid packet");return{id:a,isRequest:g,value:y}}var Qe=class{constructor(e=new Uint8Array(1024)){this.buf=e,this.len=0,this.ptr=0}_write(e){if(this.len+e>this.buf.length){let n=new Uint8Array((this.len+e)*2);n.set(this.buf),this.buf=n}return this.len+=e,this.len-e}write8(e){let n=this._write(1);this.buf[n]=e}write32(e){let n=this._write(4);Ve(this.buf,e,n)}write(e){let n=this._write(4+e.length);Ve(this.buf,e.length,n),this.buf.set(e,n+4)}_read(e){if(this.ptr+e>this.buf.length)throw new Error("Invalid packet");return this.ptr+=e,this.ptr-e}read8(){return this.buf[this._read(1)]}read32(){return Ze(this.buf,this._read(4))}read(){let e=this.read32(),n=new Uint8Array(e),r=this._read(n.length);return n.set(this.buf.subarray(r,r+e)),n}},le,be,Le;if(typeof TextEncoder<"u"&&typeof TextDecoder<"u"){let e=new TextEncoder,n=new TextDecoder;le=r=>e.encode(r),be=r=>n.decode(r),Le='new TextEncoder().encode("")'}else if(typeof Buffer<"u")le=e=>Buffer.from(e),be=e=>{let{buffer:n,byteOffset:r,byteLength:a}=e;return Buffer.from(n,r,a).toString()},Le='Buffer.from("")';else throw new Error("No UTF-8 codec found");if(!(le("")instanceof Uint8Array))throw new Error(`Invariant violation: "${Le} instanceof Uint8Array" is incorrectly false

This indicates that your JavaScript environment is broken. You cannot use
esbuild in this environment because esbuild relies on this invariant. This
is not a problem with esbuild. You need to fix your environment instead.
`);function Ze(e,n){return e[n++]|e[n++]<<8|e[n++]<<16|e[n++]<<24}function Ve(e,n,r){e[r++]=n,e[r++]=n>>8,e[r++]=n>>16,e[r++]=n>>24}var K=JSON.stringify,et="warning",tt="silent";function xe(e,n){const r=[];for(const a of e){if(ee(a,n),a.indexOf(",")>=0)throw new Error(`Invalid ${n}: ${a}`);r.push(a)}return r.join(",")}var Re=()=>null,G=e=>typeof e=="boolean"?null:"a boolean",T=e=>typeof e=="string"?null:"a string",Ie=e=>e instanceof RegExp?null:"a RegExp object",pe=e=>typeof e=="number"&&e===(e|0)?null:"an integer",kt=e=>typeof e=="number"&&e===(e|0)&&e>=0&&e<=65535?null:"a valid port number",nt=e=>typeof e=="function"?null:"a function",ce=e=>Array.isArray(e)?null:"an array",Z=e=>Array.isArray(e)&&e.every(n=>typeof n=="string")?null:"an array of strings",ne=e=>typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"an object",St=e=>typeof e=="object"&&e!==null?null:"an array or an object",jt=e=>e instanceof WebAssembly.Module?null:"a WebAssembly.Module",rt=e=>typeof e=="object"&&!Array.isArray(e)?null:"an object or null",st=e=>typeof e=="string"||typeof e=="boolean"?null:"a string or a boolean",Pt=e=>typeof e=="string"||typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"a string or an object",it=e=>typeof e=="string"||Array.isArray(e)&&e.every(n=>typeof n=="string")?null:"a string or an array of strings",lt=e=>typeof e=="string"||e instanceof Uint8Array?null:"a string or a Uint8Array",$t=e=>typeof e=="string"||e instanceof URL?null:"a string or a URL";function i(e,n,r,a){let g=e[r];if(n[r+""]=!0,g===void 0)return;let y=a(g);if(y!==null)throw new Error(`${K(r)} must be ${y}`);return g}function Y(e,n,r){for(let a in e)if(!(a in n))throw new Error(`Invalid option ${r}: ${K(a)}`)}function Tt(e){let n=Object.create(null),r=i(e,n,"wasmURL",$t),a=i(e,n,"wasmModule",jt),g=i(e,n,"worker",G);return Y(e,n,"in initialize() call"),{wasmURL:r,wasmModule:a,worker:g}}function ot(e){let n;if(e!==void 0){n=Object.create(null);for(let r in e){let a=e[r];if(typeof a=="string"||a===!1)n[r]=a;else throw new Error(`Expected ${K(r)} in mangle cache to map to either a string or false`)}}return n}function Ce(e,n,r,a,g){let y=i(n,r,"color",G),h=i(n,r,"logLevel",T),_=i(n,r,"logLimit",pe);y!==void 0?e.push(`--color=${y}`):a&&e.push("--color=true"),e.push(`--log-level=${h||g}`),e.push(`--log-limit=${_||0}`)}function ee(e,n,r){if(typeof e!="string")throw new Error(`Expected value for ${n}${r!==void 0?" "+K(r):""} to be a string, got ${typeof e} instead`);return e}function at(e,n,r){let a=i(n,r,"legalComments",T),g=i(n,r,"sourceRoot",T),y=i(n,r,"sourcesContent",G),h=i(n,r,"target",it),_=i(n,r,"format",T),u=i(n,r,"globalName",T),M=i(n,r,"mangleProps",Ie),N=i(n,r,"reserveProps",Ie),I=i(n,r,"mangleQuoted",G),z=i(n,r,"minify",G),A=i(n,r,"minifySyntax",G),V=i(n,r,"minifyWhitespace",G),B=i(n,r,"minifyIdentifiers",G),$=i(n,r,"lineLimit",pe),J=i(n,r,"drop",Z),S=i(n,r,"dropLabels",Z),k=i(n,r,"charset",T),p=i(n,r,"treeShaking",G),f=i(n,r,"ignoreAnnotations",G),s=i(n,r,"jsx",T),o=i(n,r,"jsxFactory",T),d=i(n,r,"jsxFragment",T),b=i(n,r,"jsxImportSource",T),x=i(n,r,"jsxDev",G),c=i(n,r,"jsxSideEffects",G),m=i(n,r,"define",ne),t=i(n,r,"logOverride",ne),l=i(n,r,"supported",ne),w=i(n,r,"pure",Z),v=i(n,r,"keepNames",G),j=i(n,r,"platform",T),U=i(n,r,"tsconfigRaw",Pt),q=i(n,r,"absPaths",Z);if(a&&e.push(`--legal-comments=${a}`),g!==void 0&&e.push(`--source-root=${g}`),y!==void 0&&e.push(`--sources-content=${y}`),h&&e.push(`--target=${xe(Array.isArray(h)?h:[h],"target")}`),_&&e.push(`--format=${_}`),u&&e.push(`--global-name=${u}`),j&&e.push(`--platform=${j}`),U&&e.push(`--tsconfig-raw=${typeof U=="string"?U:JSON.stringify(U)}`),z&&e.push("--minify"),A&&e.push("--minify-syntax"),V&&e.push("--minify-whitespace"),B&&e.push("--minify-identifiers"),$&&e.push(`--line-limit=${$}`),k&&e.push(`--charset=${k}`),p!==void 0&&e.push(`--tree-shaking=${p}`),f&&e.push("--ignore-annotations"),J)for(let E of J)e.push(`--drop:${ee(E,"drop")}`);if(S&&e.push(`--drop-labels=${xe(S,"drop label")}`),q&&e.push(`--abs-paths=${xe(q,"abs paths")}`),M&&e.push(`--mangle-props=${Ue(M)}`),N&&e.push(`--reserve-props=${Ue(N)}`),I!==void 0&&e.push(`--mangle-quoted=${I}`),s&&e.push(`--jsx=${s}`),o&&e.push(`--jsx-factory=${o}`),d&&e.push(`--jsx-fragment=${d}`),b&&e.push(`--jsx-import-source=${b}`),x&&e.push("--jsx-dev"),c&&e.push("--jsx-side-effects"),m)for(let E in m){if(E.indexOf("=")>=0)throw new Error(`Invalid define: ${E}`);e.push(`--define:${E}=${ee(m[E],"define",E)}`)}if(t)for(let E in t){if(E.indexOf("=")>=0)throw new Error(`Invalid log override: ${E}`);e.push(`--log-override:${E}=${ee(t[E],"log override",E)}`)}if(l)for(let E in l){if(E.indexOf("=")>=0)throw new Error(`Invalid supported: ${E}`);const W=l[E];if(typeof W!="boolean")throw new Error(`Expected value for supported ${K(E)} to be a boolean, got ${typeof W} instead`);e.push(`--supported:${E}=${W}`)}if(w)for(let E of w)e.push(`--pure:${ee(E,"pure")}`);v&&e.push("--keep-names")}function Ot(e,n,r,a,g){var y;let h=[],_=[],u=Object.create(null),M=null,N=null;Ce(h,n,u,r,a),at(h,n,u);let I=i(n,u,"sourcemap",st),z=i(n,u,"bundle",G),A=i(n,u,"splitting",G),V=i(n,u,"preserveSymlinks",G),B=i(n,u,"metafile",G),$=i(n,u,"outfile",T),J=i(n,u,"outdir",T),S=i(n,u,"outbase",T),k=i(n,u,"tsconfig",T),p=i(n,u,"resolveExtensions",Z),f=i(n,u,"nodePaths",Z),s=i(n,u,"mainFields",Z),o=i(n,u,"conditions",Z),d=i(n,u,"external",Z),b=i(n,u,"packages",T),x=i(n,u,"alias",ne),c=i(n,u,"loader",ne),m=i(n,u,"outExtension",ne),t=i(n,u,"publicPath",T),l=i(n,u,"entryNames",T),w=i(n,u,"chunkNames",T),v=i(n,u,"assetNames",T),j=i(n,u,"inject",Z),U=i(n,u,"banner",ne),q=i(n,u,"footer",ne),E=i(n,u,"entryPoints",St),W=i(n,u,"absWorkingDir",T),L=i(n,u,"stdin",ne),F=(y=i(n,u,"write",G))!=null?y:g,te=i(n,u,"allowOverwrite",G),H=i(n,u,"mangleCache",ne);if(u.plugins=!0,Y(n,u,`in ${e}() call`),I&&h.push(`--sourcemap${I===!0?"":`=${I}`}`),z&&h.push("--bundle"),te&&h.push("--allow-overwrite"),A&&h.push("--splitting"),V&&h.push("--preserve-symlinks"),B&&h.push("--metafile"),$&&h.push(`--outfile=${$}`),J&&h.push(`--outdir=${J}`),S&&h.push(`--outbase=${S}`),k&&h.push(`--tsconfig=${k}`),b&&h.push(`--packages=${b}`),p&&h.push(`--resolve-extensions=${xe(p,"resolve extension")}`),t&&h.push(`--public-path=${t}`),l&&h.push(`--entry-names=${l}`),w&&h.push(`--chunk-names=${w}`),v&&h.push(`--asset-names=${v}`),s&&h.push(`--main-fields=${xe(s,"main field")}`),o&&h.push(`--conditions=${xe(o,"condition")}`),d)for(let O of d)h.push(`--external:${ee(O,"external")}`);if(x)for(let O in x){if(O.indexOf("=")>=0)throw new Error(`Invalid package name in alias: ${O}`);h.push(`--alias:${O}=${ee(x[O],"alias",O)}`)}if(U)for(let O in U){if(O.indexOf("=")>=0)throw new Error(`Invalid banner file type: ${O}`);h.push(`--banner:${O}=${ee(U[O],"banner",O)}`)}if(q)for(let O in q){if(O.indexOf("=")>=0)throw new Error(`Invalid footer file type: ${O}`);h.push(`--footer:${O}=${ee(q[O],"footer",O)}`)}if(j)for(let O of j)h.push(`--inject:${ee(O,"inject")}`);if(c)for(let O in c){if(O.indexOf("=")>=0)throw new Error(`Invalid loader extension: ${O}`);h.push(`--loader:${O}=${ee(c[O],"loader",O)}`)}if(m)for(let O in m){if(O.indexOf("=")>=0)throw new Error(`Invalid out extension: ${O}`);h.push(`--out-extension:${O}=${ee(m[O],"out extension",O)}`)}if(E)if(Array.isArray(E))for(let O=0,de=E.length;O<de;O++){let re=E[O];if(typeof re=="object"&&re!==null){let ae=Object.create(null),he=i(re,ae,"in",T),se=i(re,ae,"out",T);if(Y(re,ae,"in entry point at index "+O),he===void 0)throw new Error('Missing property "in" for entry point at index '+O);if(se===void 0)throw new Error('Missing property "out" for entry point at index '+O);_.push([se,he])}else _.push(["",ee(re,"entry point at index "+O)])}else for(let O in E)_.push([O,ee(E[O],"entry point",O)]);if(L){let O=Object.create(null),de=i(L,O,"contents",lt),re=i(L,O,"resolveDir",T),ae=i(L,O,"sourcefile",T),he=i(L,O,"loader",T);Y(L,O,'in "stdin" object'),ae&&h.push(`--sourcefile=${ae}`),he&&h.push(`--loader=${he}`),re&&(N=re),typeof de=="string"?M=le(de):de instanceof Uint8Array&&(M=de)}let fe=[];if(f)for(let O of f)O+="",fe.push(O);return{entries:_,flags:h,write:F,stdinContents:M,stdinResolveDir:N,absWorkingDir:W,nodePaths:fe,mangleCache:ot(H)}}function Rt(e,n,r,a){let g=[],y=Object.create(null);Ce(g,n,y,r,a),at(g,n,y);let h=i(n,y,"sourcemap",st),_=i(n,y,"sourcefile",T),u=i(n,y,"loader",T),M=i(n,y,"banner",T),N=i(n,y,"footer",T),I=i(n,y,"mangleCache",ne);return Y(n,y,`in ${e}() call`),h&&g.push(`--sourcemap=${h===!0?"external":h}`),_&&g.push(`--sourcefile=${_}`),u&&g.push(`--loader=${u}`),M&&g.push(`--banner=${M}`),N&&g.push(`--footer=${N}`),{flags:g,mangleCache:ot(I)}}function It(e){const n={},r={didClose:!1,reason:""};let a={},g=0,y=0,h=new Uint8Array(16*1024),_=0,u=k=>{let p=_+k.length;if(p>h.length){let s=new Uint8Array(p*2);s.set(h),h=s}h.set(k,_),_+=k.length;let f=0;for(;f+4<=_;){let s=Ze(h,f);if(f+4+s>_)break;f+=4,V(h.subarray(f,f+s)),f+=s}f>0&&(h.copyWithin(0,f,_),_-=f)},M=k=>{r.didClose=!0,k&&(r.reason=": "+(k.message||k));const p="The service was stopped"+r.reason;for(let f in a)a[f](p,null);a={}},N=(k,p,f)=>{if(r.didClose)return f("The service is no longer running"+r.reason,null);let s=g++;a[s]=(o,d)=>{try{f(o,d)}finally{k&&k.unref()}},k&&k.ref(),e.writeToStdin(Xe({id:s,isRequest:!0,value:p}))},I=(k,p)=>{if(r.didClose)throw new Error("The service is no longer running"+r.reason);e.writeToStdin(Xe({id:k,isRequest:!1,value:p}))},z=(k,p)=>me(null,null,function*(){try{if(p.command==="ping"){I(k,{});return}if(typeof p.key=="number"){const f=n[p.key];if(!f)return;const s=f[p.command];if(s){yield s(k,p);return}}throw new Error("Invalid command: "+p.command)}catch(f){const s=[ye(f,e,null,void 0,"")];try{I(k,{errors:s})}catch{}}}),A=!0,V=k=>{if(A){A=!1;let f=String.fromCharCode(...k);if(f!=="0.25.12")throw new Error(`Cannot start service: Host version "0.25.12" does not match binary version ${K(f)}`);return}let p=_t(k);if(p.isRequest)z(p.id,p.value);else{let f=a[p.id];delete a[p.id],p.value.error?f(p.value.error,{}):f(null,p.value)}};return{readFromStdout:u,afterClose:M,service:{buildOrContext:({callName:k,refs:p,options:f,isTTY:s,defaultWD:o,callback:d})=>{let b=0;const x=y++,c={},m={ref(){++b===1&&p&&p.ref()},unref(){--b===0&&(delete n[x],p&&p.unref())}};n[x]=c,m.ref(),Ct(k,x,N,I,m,e,c,f,s,o,(t,l)=>{try{d(t,l)}finally{m.unref()}})},transform:({callName:k,refs:p,input:f,options:s,isTTY:o,fs:d,callback:b})=>{const x=ct();let c=m=>{try{if(typeof f!="string"&&!(f instanceof Uint8Array))throw new Error('The input to "transform" must be a string or a Uint8Array');let{flags:t,mangleCache:l}=Rt(k,s,o,tt),w={command:"transform",flags:t,inputFS:m!==null,input:m!==null?le(m):typeof f=="string"?le(f):f};l&&(w.mangleCache=l),N(p,w,(v,j)=>{if(v)return b(new Error(v),null);let U=Ee(j.errors,x),q=Ee(j.warnings,x),E=1,W=()=>{if(--E===0){let L={warnings:q,code:j.code,map:j.map,mangleCache:void 0,legalComments:void 0};"legalComments"in j&&(L.legalComments=j==null?void 0:j.legalComments),j.mangleCache&&(L.mangleCache=j==null?void 0:j.mangleCache),b(null,L)}};if(U.length>0)return b(ke("Transform failed",U,q),null);j.codeFS&&(E++,d.readFile(j.code,(L,F)=>{L!==null?b(L,null):(j.code=F,W())})),j.mapFS&&(E++,d.readFile(j.map,(L,F)=>{L!==null?b(L,null):(j.map=F,W())})),W()})}catch(t){let l=[];try{Ce(l,s,{},o,tt)}catch{}const w=ye(t,e,x,void 0,"");N(p,{command:"error",flags:l,error:w},()=>{w.detail=x.load(w.detail),b(ke("Transform failed",[w],[]),null)})}};if((typeof f=="string"||f instanceof Uint8Array)&&f.length>1024*1024){let m=c;c=()=>d.writeFile(f,m)}c(null)},formatMessages:({callName:k,refs:p,messages:f,options:s,callback:o})=>{if(!s)throw new Error(`Missing second argument in ${k}() call`);let d={},b=i(s,d,"kind",T),x=i(s,d,"color",G),c=i(s,d,"terminalWidth",pe);if(Y(s,d,`in ${k}() call`),b===void 0)throw new Error(`Missing "kind" in ${k}() call`);if(b!=="error"&&b!=="warning")throw new Error(`Expected "kind" to be "error" or "warning" in ${k}() call`);let m={command:"format-msgs",messages:ue(f,"messages",null,"",c),isWarning:b==="warning"};x!==void 0&&(m.color=x),c!==void 0&&(m.terminalWidth=c),N(p,m,(t,l)=>{if(t)return o(new Error(t),null);o(null,l.messages)})},analyzeMetafile:({callName:k,refs:p,metafile:f,options:s,callback:o})=>{s===void 0&&(s={});let d={},b=i(s,d,"color",G),x=i(s,d,"verbose",G);Y(s,d,`in ${k}() call`);let c={command:"analyze-metafile",metafile:f};b!==void 0&&(c.color=b),x!==void 0&&(c.verbose=x),N(p,c,(m,t)=>{if(m)return o(new Error(m),null);o(null,t.result)})}}}}function Ct(e,n,r,a,g,y,h,_,u,M,N){const I=ct(),z=e==="context",A=($,J)=>{const S=[];try{Ce(S,_,{},u,et)}catch{}const k=ye($,y,I,void 0,J);r(g,{command:"error",flags:S,error:k},()=>{k.detail=I.load(k.detail),N(ke(z?"Context failed":"Build failed",[k],[]),null)})};let V;if(typeof _=="object"){const $=_.plugins;if($!==void 0){if(!Array.isArray($))return A(new Error('"plugins" must be an array'),"");V=$}}if(V&&V.length>0){if(y.isSync)return A(new Error("Cannot use plugins in synchronous API calls"),"");Dt(n,r,a,g,y,h,_,V,I).then($=>{if(!$.ok)return A($.error,$.pluginName);try{B($.requestPlugins,$.runOnEndCallbacks,$.scheduleOnDisposeCallbacks)}catch(J){A(J,"")}},$=>A($,""));return}try{B(null,($,J)=>J([],[]),()=>{})}catch($){A($,"")}function B($,J,S){const k=y.hasFS,{entries:p,flags:f,write:s,stdinContents:o,stdinResolveDir:d,absWorkingDir:b,nodePaths:x,mangleCache:c}=Ot(e,_,u,et,k);if(s&&!y.hasFS)throw new Error('The "write" option is unavailable in this environment');const m={command:"build",key:n,entries:p,flags:f,write:s,stdinContents:o,stdinResolveDir:d,absWorkingDir:b||M,nodePaths:x,context:z};$&&(m.plugins=$),c&&(m.mangleCache=c);const t=(v,j)=>{const U={errors:Ee(v.errors,I),warnings:Ee(v.warnings,I),outputFiles:void 0,metafile:void 0,mangleCache:void 0},q=U.errors.slice(),E=U.warnings.slice();v.outputFiles&&(U.outputFiles=v.outputFiles.map(Ut)),v.metafile&&(U.metafile=JSON.parse(v.metafile)),v.mangleCache&&(U.mangleCache=v.mangleCache),v.writeToStdout!==void 0&&console.log(be(v.writeToStdout).replace(/\n$/,"")),J(U,(W,L)=>{if(q.length>0||W.length>0){const F=ke("Build failed",q.concat(W),E.concat(L));return j(F,null,W,L)}j(null,U,W,L)})};let l,w;z&&(h["on-end"]=(v,j)=>new Promise(U=>{t(j,(q,E,W,L)=>{const F={errors:W,warnings:L};w&&w(q,E),l=void 0,w=void 0,a(v,F),U()})})),r(g,m,(v,j)=>{if(v)return N(new Error(v),null);if(!z)return t(j,(E,W)=>(S(),N(E,W)));if(j.errors.length>0)return N(ke("Context failed",j.errors,j.warnings),null);let U=!1;const q={rebuild:()=>(l||(l=new Promise((E,W)=>{let L;w=(te,H)=>{L||(L=()=>te?W(te):E(H))};const F=()=>{r(g,{command:"rebuild",key:n},(H,fe)=>{H?W(new Error(H)):L?L():F()})};F()})),l),watch:(E={})=>new Promise((W,L)=>{if(!y.hasFS)throw new Error('Cannot use the "watch" API in this environment');const F={},te=i(E,F,"delay",pe);Y(E,F,"in watch() call");const H={command:"watch",key:n};te&&(H.delay=te),r(g,H,fe=>{fe?L(new Error(fe)):W(void 0)})}),serve:(E={})=>new Promise((W,L)=>{if(!y.hasFS)throw new Error('Cannot use the "serve" API in this environment');const F={},te=i(E,F,"port",kt),H=i(E,F,"host",T),fe=i(E,F,"servedir",T),O=i(E,F,"keyfile",T),de=i(E,F,"certfile",T),re=i(E,F,"fallback",T),ae=i(E,F,"cors",ne),he=i(E,F,"onRequest",nt);Y(E,F,"in serve() call");const se={command:"serve",key:n,onRequest:!!he};if(te!==void 0&&(se.port=te),H!==void 0&&(se.host=H),fe!==void 0&&(se.servedir=fe),O!==void 0&&(se.keyfile=O),de!==void 0&&(se.certfile=de),re!==void 0&&(se.fallback=re),ae){const je={},_e=i(ae,je,"origin",it);Y(ae,je,'on "cors" object'),Array.isArray(_e)?se.corsOrigin=_e:_e!==void 0&&(se.corsOrigin=[_e])}r(g,se,(je,_e)=>{if(je)return L(new Error(je));he&&(h["serve-request"]=(Xt,Qt)=>{he(Qt.args),a(Xt,{})}),W(_e)})}),cancel:()=>new Promise(E=>{if(U)return E();r(g,{command:"cancel",key:n},()=>{E()})}),dispose:()=>new Promise(E=>{if(U)return E();U=!0,r(g,{command:"dispose",key:n},()=>{E(),S(),g.unref()})})};g.ref(),N(null,q)})}}var Dt=(e,n,r,a,g,y,h,_,u)=>me(null,null,function*(){let M=[],N=[],I={},z={},A=[],V=0,B=0,$=[],J=!1;_=[..._];for(let p of _){let f={};if(typeof p!="object")throw new Error(`Plugin at index ${B} must be an object`);const s=i(p,f,"name",T);if(typeof s!="string"||s==="")throw new Error(`Plugin at index ${B} is missing a name`);try{let o=i(p,f,"setup",nt);if(typeof o!="function")throw new Error("Plugin is missing a setup function");Y(p,f,`on plugin ${K(s)}`);let d={name:s,onStart:!1,onEnd:!1,onResolve:[],onLoad:[]};B++;let x=o({initialOptions:h,resolve:(c,m={})=>{if(!J)throw new Error('Cannot call "resolve" before plugin setup has completed');if(typeof c!="string")throw new Error("The path to resolve must be a string");let t=Object.create(null),l=i(m,t,"pluginName",T),w=i(m,t,"importer",T),v=i(m,t,"namespace",T),j=i(m,t,"resolveDir",T),U=i(m,t,"kind",T),q=i(m,t,"pluginData",Re),E=i(m,t,"with",ne);return Y(m,t,"in resolve() call"),new Promise((W,L)=>{const F={command:"resolve",path:c,key:e,pluginName:s};if(l!=null&&(F.pluginName=l),w!=null&&(F.importer=w),v!=null&&(F.namespace=v),j!=null&&(F.resolveDir=j),U!=null)F.kind=U;else throw new Error('Must specify "kind" when calling "resolve"');q!=null&&(F.pluginData=u.store(q)),E!=null&&(F.with=At(E,"with")),n(a,F,(te,H)=>{te!==null?L(new Error(te)):W({errors:Ee(H.errors,u),warnings:Ee(H.warnings,u),path:H.path,external:H.external,sideEffects:H.sideEffects,namespace:H.namespace,suffix:H.suffix,pluginData:u.load(H.pluginData)})})})},onStart(c){let m='This error came from the "onStart" callback registered here:',t=De(new Error(m),g,"onStart");M.push({name:s,callback:c,note:t}),d.onStart=!0},onEnd(c){let m='This error came from the "onEnd" callback registered here:',t=De(new Error(m),g,"onEnd");N.push({name:s,callback:c,note:t}),d.onEnd=!0},onResolve(c,m){let t='This error came from the "onResolve" callback registered here:',l=De(new Error(t),g,"onResolve"),w={},v=i(c,w,"filter",Ie),j=i(c,w,"namespace",T);if(Y(c,w,`in onResolve() call for plugin ${K(s)}`),v==null)throw new Error("onResolve() call is missing a filter");let U=V++;I[U]={name:s,callback:m,note:l},d.onResolve.push({id:U,filter:Ue(v),namespace:j||""})},onLoad(c,m){let t='This error came from the "onLoad" callback registered here:',l=De(new Error(t),g,"onLoad"),w={},v=i(c,w,"filter",Ie),j=i(c,w,"namespace",T);if(Y(c,w,`in onLoad() call for plugin ${K(s)}`),v==null)throw new Error("onLoad() call is missing a filter");let U=V++;z[U]={name:s,callback:m,note:l},d.onLoad.push({id:U,filter:Ue(v),namespace:j||""})},onDispose(c){A.push(c)},esbuild:g.esbuild});x&&(yield x),$.push(d)}catch(o){return{ok:!1,error:o,pluginName:s}}}y["on-start"]=(p,f)=>me(null,null,function*(){u.clear();let s={errors:[],warnings:[]};yield Promise.all(M.map(o=>me(null,[o],function*({name:d,callback:b,note:x}){try{let c=yield b();if(c!=null){if(typeof c!="object")throw new Error(`Expected onStart() callback in plugin ${K(d)} to return an object`);let m={},t=i(c,m,"errors",ce),l=i(c,m,"warnings",ce);Y(c,m,`from onStart() callback in plugin ${K(d)}`),t!=null&&s.errors.push(...ue(t,"errors",u,d,void 0)),l!=null&&s.warnings.push(...ue(l,"warnings",u,d,void 0))}}catch(c){s.errors.push(ye(c,g,u,x&&x(),d))}}))),r(p,s)}),y["on-resolve"]=(p,f)=>me(null,null,function*(){let s={},o="",d,b;for(let x of f.ids)try{({name:o,callback:d,note:b}=I[x]);let c=yield d({path:f.path,importer:f.importer,namespace:f.namespace,resolveDir:f.resolveDir,kind:f.kind,pluginData:u.load(f.pluginData),with:f.with});if(c!=null){if(typeof c!="object")throw new Error(`Expected onResolve() callback in plugin ${K(o)} to return an object`);let m={},t=i(c,m,"pluginName",T),l=i(c,m,"path",T),w=i(c,m,"namespace",T),v=i(c,m,"suffix",T),j=i(c,m,"external",G),U=i(c,m,"sideEffects",G),q=i(c,m,"pluginData",Re),E=i(c,m,"errors",ce),W=i(c,m,"warnings",ce),L=i(c,m,"watchFiles",Z),F=i(c,m,"watchDirs",Z);Y(c,m,`from onResolve() callback in plugin ${K(o)}`),s.id=x,t!=null&&(s.pluginName=t),l!=null&&(s.path=l),w!=null&&(s.namespace=w),v!=null&&(s.suffix=v),j!=null&&(s.external=j),U!=null&&(s.sideEffects=U),q!=null&&(s.pluginData=u.store(q)),E!=null&&(s.errors=ue(E,"errors",u,o,void 0)),W!=null&&(s.warnings=ue(W,"warnings",u,o,void 0)),L!=null&&(s.watchFiles=Ae(L,"watchFiles")),F!=null&&(s.watchDirs=Ae(F,"watchDirs"));break}}catch(c){s={id:x,errors:[ye(c,g,u,b&&b(),o)]};break}r(p,s)}),y["on-load"]=(p,f)=>me(null,null,function*(){let s={},o="",d,b;for(let x of f.ids)try{({name:o,callback:d,note:b}=z[x]);let c=yield d({path:f.path,namespace:f.namespace,suffix:f.suffix,pluginData:u.load(f.pluginData),with:f.with});if(c!=null){if(typeof c!="object")throw new Error(`Expected onLoad() callback in plugin ${K(o)} to return an object`);let m={},t=i(c,m,"pluginName",T),l=i(c,m,"contents",lt),w=i(c,m,"resolveDir",T),v=i(c,m,"pluginData",Re),j=i(c,m,"loader",T),U=i(c,m,"errors",ce),q=i(c,m,"warnings",ce),E=i(c,m,"watchFiles",Z),W=i(c,m,"watchDirs",Z);Y(c,m,`from onLoad() callback in plugin ${K(o)}`),s.id=x,t!=null&&(s.pluginName=t),l instanceof Uint8Array?s.contents=l:l!=null&&(s.contents=le(l)),w!=null&&(s.resolveDir=w),v!=null&&(s.pluginData=u.store(v)),j!=null&&(s.loader=j),U!=null&&(s.errors=ue(U,"errors",u,o,void 0)),q!=null&&(s.warnings=ue(q,"warnings",u,o,void 0)),E!=null&&(s.watchFiles=Ae(E,"watchFiles")),W!=null&&(s.watchDirs=Ae(W,"watchDirs"));break}}catch(c){s={id:x,errors:[ye(c,g,u,b&&b(),o)]};break}r(p,s)});let S=(p,f)=>f([],[]);N.length>0&&(S=(p,f)=>{me(null,null,function*(){const s=[],o=[];for(const{name:d,callback:b,note:x}of N){let c,m;try{const t=yield b(p);if(t!=null){if(typeof t!="object")throw new Error(`Expected onEnd() callback in plugin ${K(d)} to return an object`);let l={},w=i(t,l,"errors",ce),v=i(t,l,"warnings",ce);Y(t,l,`from onEnd() callback in plugin ${K(d)}`),w!=null&&(c=ue(w,"errors",u,d,void 0)),v!=null&&(m=ue(v,"warnings",u,d,void 0))}}catch(t){c=[ye(t,g,u,x&&x(),d)]}if(c){s.push(...c);try{p.errors.push(...c)}catch{}}if(m){o.push(...m);try{p.warnings.push(...m)}catch{}}}f(s,o)})});let k=()=>{for(const p of A)setTimeout(()=>p(),0)};return J=!0,{ok:!0,requestPlugins:$,runOnEndCallbacks:S,scheduleOnDisposeCallbacks:k}});function ct(){const e=new Map;let n=0;return{clear(){e.clear()},load(r){return e.get(r)},store(r){if(r===void 0)return-1;const a=n++;return e.set(a,r),a}}}function De(e,n,r){let a,g=!1;return()=>{if(g)return a;g=!0;try{let y=(e.stack+"").split(`
`);y.splice(1,1);let h=ut(n,y,r);if(h)return a={text:e.message,location:h},a}catch{}}}function ye(e,n,r,a,g){let y="Internal error",h=null;try{y=(e&&e.message||e)+""}catch{}try{h=ut(n,(e.stack+"").split(`
`),"")}catch{}return{id:"",pluginName:g,text:y,location:h,notes:a?[a]:[],detail:r?r.store(e):-1}}function ut(e,n,r){let a="    at ";if(e.readFileSync&&!n[0].startsWith(a)&&n[1].startsWith(a))for(let g=1;g<n.length;g++){let y=n[g];if(y.startsWith(a))for(y=y.slice(a.length);;){let h=/^(?:new |async )?\S+ \((.*)\)$/.exec(y);if(h){y=h[1];continue}if(h=/^eval at \S+ \((.*)\)(?:, \S+:\d+:\d+)?$/.exec(y),h){y=h[1];continue}if(h=/^(\S+):(\d+):(\d+)$/.exec(y),h){let _;try{_=e.readFileSync(h[1],"utf8")}catch{break}let u=_.split(/\r\n|\r|\n|\u2028|\u2029/)[+h[2]-1]||"",M=+h[3]-1,N=u.slice(M,M+r.length)===r?r.length:0;return{file:h[1],namespace:"file",line:+h[2],column:le(u.slice(0,M)).length,length:le(u.slice(M,M+N)).length,lineText:u+`
`+n.slice(1).join(`
`),suggestion:""}}break}}return null}function ke(e,n,r){let a=5;e+=n.length<1?"":` with ${n.length} error${n.length<2?"":"s"}:`+n.slice(0,a+1).map((y,h)=>{if(h===a)return`
...`;if(!y.location)return`
error: ${y.text}`;let{file:_,line:u,column:M}=y.location,N=y.pluginName?`[plugin: ${y.pluginName}] `:"";return`
${_}:${u}:${M}: ERROR: ${N}${y.text}`}).join("");let g=new Error(e);for(const[y,h]of[["errors",n],["warnings",r]])Object.defineProperty(g,y,{configurable:!0,enumerable:!0,get:()=>h,set:_=>Object.defineProperty(g,y,{configurable:!0,enumerable:!0,value:_})});return g}function Ee(e,n){for(const r of e)r.detail=n.load(r.detail);return e}function ft(e,n,r){if(e==null)return null;let a={},g=i(e,a,"file",T),y=i(e,a,"namespace",T),h=i(e,a,"line",pe),_=i(e,a,"column",pe),u=i(e,a,"length",pe),M=i(e,a,"lineText",T),N=i(e,a,"suggestion",T);if(Y(e,a,n),M){const I=M.slice(0,(_&&_>0?_:0)+(u&&u>0?u:0)+(r&&r>0?r:80));!/[\x7F-\uFFFF]/.test(I)&&!/\n/.test(M)&&(M=I)}return{file:g||"",namespace:y||"",line:h||0,column:_||0,length:u||0,lineText:M||"",suggestion:N||""}}function ue(e,n,r,a,g){let y=[],h=0;for(const _ of e){let u={},M=i(_,u,"id",T),N=i(_,u,"pluginName",T),I=i(_,u,"text",T),z=i(_,u,"location",rt),A=i(_,u,"notes",ce),V=i(_,u,"detail",Re),B=`in element ${h} of "${n}"`;Y(_,u,B);let $=[];if(A)for(const J of A){let S={},k=i(J,S,"text",T),p=i(J,S,"location",rt);Y(J,S,B),$.push({text:k||"",location:ft(p,B,g)})}y.push({id:M||"",pluginName:N||a,text:I||"",location:ft(z,B,g),notes:$,detail:r?r.store(V):-1}),h++}return y}function Ae(e,n){const r=[];for(const a of e){if(typeof a!="string")throw new Error(`${K(n)} must be an array of strings`);r.push(a)}return r}function At(e,n){const r=Object.create(null);for(const a in e){const g=e[a];if(typeof g!="string")throw new Error(`key ${K(a)} in object ${K(n)} must be a string`);r[a]=g}return r}function Ut({path:e,contents:n,hash:r}){let a=null;return{path:e,contents:n,hash:r,get text(){const g=this.contents;return(a===null||g!==n)&&(n=g,a=be(g)),a}}}function Ue(e){let n=e.source;return e.flags&&(n=`(?${e.flags})${n}`),n}var Mt="0.25.12",Nt=e=>Se().build(e),Ft=e=>Se().context(e),Lt=(e,n)=>Se().transform(e,n),Vt=(e,n)=>Se().formatMessages(e,n),Bt=(e,n)=>Se().analyzeMetafile(e,n),Wt=()=>{throw new Error('The "buildSync" API only works in node')},zt=()=>{throw new Error('The "transformSync" API only works in node')},qt=()=>{throw new Error('The "formatMessagesSync" API only works in node')},Gt=()=>{throw new Error('The "analyzeMetafileSync" API only works in node')},Jt=()=>(Me&&Me(),Promise.resolve()),we,Me,Ne,Se=()=>{if(Ne)return Ne;throw we?new Error('You need to wait for the promise returned from "initialize" to be resolved before calling this'):new Error('You need to call "initialize" before calling this')},Yt=e=>{e=Tt(e||{});let n=e.wasmURL,r=e.wasmModule,a=e.worker!==!1;if(!n&&!r)throw new Error('Must provide either the "wasmURL" option or the "wasmModule" option');if(we)throw new Error('Cannot call "initialize" more than once');return we=Ht(n||"",r,a),we.catch(()=>{we=void 0}),we},Ht=(e,n,r)=>me(null,null,function*(){let a,g;const y=new Promise(I=>g=I);if(r){let I=new Blob([`onmessage=((postMessage) => {
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
    })(postMessage)`],{type:"text/javascript"});a=new Worker(URL.createObjectURL(I))}else{let I=(A=>{var V=(S,k,p)=>new Promise((f,s)=>{var o=x=>{try{b(p.next(x))}catch(c){s(c)}},d=x=>{try{b(p.throw(x))}catch(c){s(c)}},b=x=>x.done?f(x.value):Promise.resolve(x.value).then(o,d);b((p=p.apply(S,k)).next())});let B,$={};for(let S=self;S;S=Object.getPrototypeOf(S))for(let k of Object.getOwnPropertyNames(S))k in $||Object.defineProperty($,k,{get:()=>self[k]});(()=>{const S=()=>{const f=new Error("not implemented");return f.code="ENOSYS",f};if(!$.fs){let f="";$.fs={constants:{O_WRONLY:-1,O_RDWR:-1,O_CREAT:-1,O_TRUNC:-1,O_APPEND:-1,O_EXCL:-1},writeSync(s,o){f+=p.decode(o);const d=f.lastIndexOf(`
`);return d!=-1&&(console.log(f.substring(0,d)),f=f.substring(d+1)),o.length},write(s,o,d,b,x,c){if(d!==0||b!==o.length||x!==null){c(S());return}const m=this.writeSync(s,o);c(null,m)},chmod(s,o,d){d(S())},chown(s,o,d,b){b(S())},close(s,o){o(S())},fchmod(s,o,d){d(S())},fchown(s,o,d,b){b(S())},fstat(s,o){o(S())},fsync(s,o){o(null)},ftruncate(s,o,d){d(S())},lchown(s,o,d,b){b(S())},link(s,o,d){d(S())},lstat(s,o){o(S())},mkdir(s,o,d){d(S())},open(s,o,d,b){b(S())},read(s,o,d,b,x,c){c(S())},readdir(s,o){o(S())},readlink(s,o){o(S())},rename(s,o,d){d(S())},rmdir(s,o){o(S())},stat(s,o){o(S())},symlink(s,o,d){d(S())},truncate(s,o,d){d(S())},unlink(s,o){o(S())},utimes(s,o,d,b){b(S())}}}if($.process||($.process={getuid(){return-1},getgid(){return-1},geteuid(){return-1},getegid(){return-1},getgroups(){throw S()},pid:-1,ppid:-1,umask(){throw S()},cwd(){throw S()},chdir(){throw S()}}),!$.crypto)throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");if(!$.performance)throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");if(!$.TextEncoder)throw new Error("globalThis.TextEncoder is not available, polyfill required");if(!$.TextDecoder)throw new Error("globalThis.TextDecoder is not available, polyfill required");const k=new TextEncoder("utf-8"),p=new TextDecoder("utf-8");$.Go=class{constructor(){this.argv=["js"],this.env={},this.exit=t=>{t!==0&&console.warn("exit code:",t)},this._exitPromise=new Promise(t=>{this._resolveExitPromise=t}),this._pendingEvent=null,this._scheduledTimeouts=new Map,this._nextCallbackTimeoutID=1;const f=(t,l)=>{this.mem.setUint32(t+0,l,!0),this.mem.setUint32(t+4,Math.floor(l/4294967296),!0)},s=t=>{const l=this.mem.getUint32(t+0,!0),w=this.mem.getInt32(t+4,!0);return l+w*4294967296},o=t=>{const l=this.mem.getFloat64(t,!0);if(l===0)return;if(!isNaN(l))return l;const w=this.mem.getUint32(t,!0);return this._values[w]},d=(t,l)=>{if(typeof l=="number"&&l!==0){if(isNaN(l)){this.mem.setUint32(t+4,2146959360,!0),this.mem.setUint32(t,0,!0);return}this.mem.setFloat64(t,l,!0);return}if(l===void 0){this.mem.setFloat64(t,0,!0);return}let v=this._ids.get(l);v===void 0&&(v=this._idPool.pop(),v===void 0&&(v=this._values.length),this._values[v]=l,this._goRefCounts[v]=0,this._ids.set(l,v)),this._goRefCounts[v]++;let j=0;switch(typeof l){case"object":l!==null&&(j=1);break;case"string":j=2;break;case"symbol":j=3;break;case"function":j=4;break}this.mem.setUint32(t+4,2146959360|j,!0),this.mem.setUint32(t,v,!0)},b=t=>{const l=s(t+0),w=s(t+8);return new Uint8Array(this._inst.exports.mem.buffer,l,w)},x=t=>{const l=s(t+0),w=s(t+8),v=new Array(w);for(let j=0;j<w;j++)v[j]=o(l+j*8);return v},c=t=>{const l=s(t+0),w=s(t+8);return p.decode(new DataView(this._inst.exports.mem.buffer,l,w))},m=Date.now()-performance.now();this.importObject={_gotest:{add:(t,l)=>t+l},gojs:{"runtime.wasmExit":t=>{t>>>=0;const l=this.mem.getInt32(t+8,!0);this.exited=!0,delete this._inst,delete this._values,delete this._goRefCounts,delete this._ids,delete this._idPool,this.exit(l)},"runtime.wasmWrite":t=>{t>>>=0;const l=s(t+8),w=s(t+16),v=this.mem.getInt32(t+24,!0);$.fs.writeSync(l,new Uint8Array(this._inst.exports.mem.buffer,w,v))},"runtime.resetMemoryDataView":t=>{this.mem=new DataView(this._inst.exports.mem.buffer)},"runtime.nanotime1":t=>{t>>>=0,f(t+8,(m+performance.now())*1e6)},"runtime.walltime":t=>{t>>>=0;const l=new Date().getTime();f(t+8,l/1e3),this.mem.setInt32(t+16,l%1e3*1e6,!0)},"runtime.scheduleTimeoutEvent":t=>{t>>>=0;const l=this._nextCallbackTimeoutID;this._nextCallbackTimeoutID++,this._scheduledTimeouts.set(l,setTimeout(()=>{for(this._resume();this._scheduledTimeouts.has(l);)console.warn("scheduleTimeoutEvent: missed timeout event"),this._resume()},s(t+8))),this.mem.setInt32(t+16,l,!0)},"runtime.clearTimeoutEvent":t=>{t>>>=0;const l=this.mem.getInt32(t+8,!0);clearTimeout(this._scheduledTimeouts.get(l)),this._scheduledTimeouts.delete(l)},"runtime.getRandomData":t=>{t>>>=0,crypto.getRandomValues(b(t+8))},"syscall/js.finalizeRef":t=>{t>>>=0;const l=this.mem.getUint32(t+8,!0);if(this._goRefCounts[l]--,this._goRefCounts[l]===0){const w=this._values[l];this._values[l]=null,this._ids.delete(w),this._idPool.push(l)}},"syscall/js.stringVal":t=>{t>>>=0,d(t+24,c(t+8))},"syscall/js.valueGet":t=>{t>>>=0;const l=Reflect.get(o(t+8),c(t+16));t=this._inst.exports.getsp()>>>0,d(t+32,l)},"syscall/js.valueSet":t=>{t>>>=0,Reflect.set(o(t+8),c(t+16),o(t+32))},"syscall/js.valueDelete":t=>{t>>>=0,Reflect.deleteProperty(o(t+8),c(t+16))},"syscall/js.valueIndex":t=>{t>>>=0,d(t+24,Reflect.get(o(t+8),s(t+16)))},"syscall/js.valueSetIndex":t=>{t>>>=0,Reflect.set(o(t+8),s(t+16),o(t+24))},"syscall/js.valueCall":t=>{t>>>=0;try{const l=o(t+8),w=Reflect.get(l,c(t+16)),v=x(t+32),j=Reflect.apply(w,l,v);t=this._inst.exports.getsp()>>>0,d(t+56,j),this.mem.setUint8(t+64,1)}catch(l){t=this._inst.exports.getsp()>>>0,d(t+56,l),this.mem.setUint8(t+64,0)}},"syscall/js.valueInvoke":t=>{t>>>=0;try{const l=o(t+8),w=x(t+16),v=Reflect.apply(l,void 0,w);t=this._inst.exports.getsp()>>>0,d(t+40,v),this.mem.setUint8(t+48,1)}catch(l){t=this._inst.exports.getsp()>>>0,d(t+40,l),this.mem.setUint8(t+48,0)}},"syscall/js.valueNew":t=>{t>>>=0;try{const l=o(t+8),w=x(t+16),v=Reflect.construct(l,w);t=this._inst.exports.getsp()>>>0,d(t+40,v),this.mem.setUint8(t+48,1)}catch(l){t=this._inst.exports.getsp()>>>0,d(t+40,l),this.mem.setUint8(t+48,0)}},"syscall/js.valueLength":t=>{t>>>=0,f(t+16,parseInt(o(t+8).length))},"syscall/js.valuePrepareString":t=>{t>>>=0;const l=k.encode(String(o(t+8)));d(t+16,l),f(t+24,l.length)},"syscall/js.valueLoadString":t=>{t>>>=0;const l=o(t+8);b(t+16).set(l)},"syscall/js.valueInstanceOf":t=>{t>>>=0,this.mem.setUint8(t+24,o(t+8)instanceof o(t+16)?1:0)},"syscall/js.copyBytesToGo":t=>{t>>>=0;const l=b(t+8),w=o(t+32);if(!(w instanceof Uint8Array||w instanceof Uint8ClampedArray)){this.mem.setUint8(t+48,0);return}const v=w.subarray(0,l.length);l.set(v),f(t+40,v.length),this.mem.setUint8(t+48,1)},"syscall/js.copyBytesToJS":t=>{t>>>=0;const l=o(t+8),w=b(t+16);if(!(l instanceof Uint8Array||l instanceof Uint8ClampedArray)){this.mem.setUint8(t+48,0);return}const v=w.subarray(0,l.length);l.set(v),f(t+40,v.length),this.mem.setUint8(t+48,1)},debug:t=>{console.log(t)}}}}run(f){return V(this,null,function*(){if(!(f instanceof WebAssembly.Instance))throw new Error("Go.run: WebAssembly.Instance expected");this._inst=f,this.mem=new DataView(this._inst.exports.mem.buffer),this._values=[NaN,0,null,!0,!1,$,this],this._goRefCounts=new Array(this._values.length).fill(1/0),this._ids=new Map([[0,1],[null,2],[!0,3],[!1,4],[$,5],[this,6]]),this._idPool=[],this.exited=!1;let s=4096;const o=t=>{const l=s,w=k.encode(t+"\0");return new Uint8Array(this.mem.buffer,s,w.length).set(w),s+=w.length,s%8!==0&&(s+=8-s%8),l},d=this.argv.length,b=[];this.argv.forEach(t=>{b.push(o(t))}),b.push(0),Object.keys(this.env).sort().forEach(t=>{b.push(o(`${t}=${this.env[t]}`))}),b.push(0);const c=s;if(b.forEach(t=>{this.mem.setUint32(s,t,!0),this.mem.setUint32(s+4,0,!0),s+=8}),s>=12288)throw new Error("total length of command line and environment variables exceeds limit");this._inst.exports.run(d,c),this.exited&&this._resolveExitPromise(),yield this._exitPromise})}_resume(){if(this.exited)throw new Error("Go program has already exited");this._inst.exports.resume(),this.exited&&this._resolveExitPromise()}_makeFuncWrapper(f){const s=this;return function(){const o={id:f,this:this,args:arguments};return s._pendingEvent=o,s._resume(),o.result}}}})(),B=({data:S})=>{let k=new TextDecoder,p=$.fs,f="";p.writeSync=(x,c)=>{if(x===1)A(c);else if(x===2){f+=k.decode(c);let m=f.split(`
`);m.length>1&&console.log(m.slice(0,-1).join(`
`)),f=m[m.length-1]}else throw new Error("Bad write");return c.length};let s=[],o,d=0;B=({data:x})=>(x.length>0&&(s.push(x),o&&o()),b),p.read=(x,c,m,t,l,w)=>{if(x!==0||m!==0||t!==c.length||l!==null)throw new Error("Bad read");if(s.length===0){o=()=>p.read(x,c,m,t,l,w);return}let v=s[0],j=Math.max(0,Math.min(t,v.length-d));c.set(v.subarray(d,d+j),m),d+=j,d===v.length&&(s.shift(),d=0),w(null,j)};let b=new $.Go;return b.argv=["","--service=0.25.12"],J(S,b).then(x=>{A(null),b.run(x)},x=>{A(x)}),b};function J(S,k){return V(this,null,function*(){if(S instanceof WebAssembly.Module)return WebAssembly.instantiate(S,k.importObject);const p=yield fetch(S);if(!p.ok)throw new Error(`Failed to download ${JSON.stringify(S)}`);if("instantiateStreaming"in WebAssembly&&/^application\/wasm($|;)/i.test(p.headers.get("Content-Type")||""))return(yield WebAssembly.instantiateStreaming(p,k.importObject)).instance;const f=yield p.arrayBuffer();return(yield WebAssembly.instantiate(f,k.importObject)).instance})}return S=>B(S)})(A=>a.onmessage({data:A})),z;a={onmessage:null,postMessage:A=>setTimeout(()=>{try{z=I({data:A})}catch(V){g(V)}}),terminate(){if(z)for(let A of z._scheduledTimeouts.values())clearTimeout(A)}}}let h,_;const u=new Promise((I,z)=>{h=I,_=z});a.onmessage=({data:I})=>{a.onmessage=({data:z})=>M(z),I?_(I):h()},a.postMessage(n||new URL(e,location.href).toString());let{readFromStdout:M,service:N}=It({writeToStdin(I){a.postMessage(I)},isSync:!1,hasFS:!1,esbuild:Oe});yield u,Me=()=>{a.terminate(),we=void 0,Me=void 0,Ne=void 0},Ne={build:I=>new Promise((z,A)=>{y.then(A),N.buildOrContext({callName:"build",refs:null,options:I,isTTY:!1,defaultWD:"/",callback:(V,B)=>V?A(V):z(B)})}),context:I=>new Promise((z,A)=>{y.then(A),N.buildOrContext({callName:"context",refs:null,options:I,isTTY:!1,defaultWD:"/",callback:(V,B)=>V?A(V):z(B)})}),transform:(I,z)=>new Promise((A,V)=>{y.then(V),N.transform({callName:"transform",refs:null,input:I,options:z||{},isTTY:!1,fs:{readFile(B,$){$(new Error("Internal error"),null)},writeFile(B,$){$(null)}},callback:(B,$)=>B?V(B):A($)})}),formatMessages:(I,z)=>new Promise((A,V)=>{y.then(V),N.formatMessages({callName:"formatMessages",refs:null,messages:I,options:z,callback:(B,$)=>B?V(B):A($)})}),analyzeMetafile:(I,z)=>new Promise((A,V)=>{y.then(V),N.analyzeMetafile({callName:"analyzeMetafile",refs:null,metafile:typeof I=="string"?I:JSON.stringify(I),options:z,callback:(B,$)=>B?V(B):A($)})})}}),Kt=Oe})(R)})(Be);var We=Be.exports,dt=""+new URL("esbuild-BHljloGq.wasm",self.location.href).href;const ht="..";function ve(R){if(typeof R!="string"||R.includes("\0"))throw new Error("Preview path must be a valid string.");const C=R.trim().replace(/\\/g,"/").split("/");if(C.includes(ht))throw new Error(`Preview path cannot traverse outside the virtual root: ${R}`);const D=C.filter(Q=>Q&&Q!==".");if(D.length===0)throw new Error("Preview path must point to a file below /.");return`/${D.join("/")}`}function mt(R,P){const C=R==="/"?"/":ve(R),D=P.trim().replace(/\\/g,"/");if(D.startsWith("/"))return ve(D);const Q=C==="/"?[]:C.slice(1).split("/");for(const X of D.split("/"))if(!(!X||X==="."))if(X===".."){if(Q.length===0)throw new Error(`Preview path cannot traverse outside the virtual root: ${P}`);Q.pop()}else Q.push(X);if(Q.length===0)throw new Error("Preview path must point to a file below /.");return ve(`/${Q.join("/")}`)}function ze(R){return R.map(P=>{var C,D,Q,X,oe;return{message:P.text??P.message??"Unknown build error",file:((D=(C=P.location)==null?void 0:C.file)==null?void 0:D.replace(/^preview-vfs:/,""))||null,line:((Q=P.location)==null?void 0:Q.line)??null,column:((X=P.location)==null?void 0:X.column)===void 0?null:P.location.column+1,lineText:((oe=P.location)==null?void 0:oe.lineText)||null}})}function gt(R){return typeof R=="object"&&R!==null&&"errors"in R&&Array.isArray(R.errors)?ze(R.errors):[{message:R instanceof Error?R.message:String(R),file:null,line:null,column:null,lineText:null}]}const pt=new Set(["react","react/jsx-runtime","react/jsx-dev-runtime","react-dom","react-dom/client","three"]);function yt(R){return!R.startsWith(".")&&!R.startsWith("/")}function wt(R){if(!pt.has(R))throw new Error(`Dependency "${R}" is not allowed in Preview Project.`);return R}const Fe=[".ts",".tsx",".js",".jsx",".css",".json"];function qe(R){const P=R.slice(R.lastIndexOf("/")+1),C=P.lastIndexOf(".");return C<0?"":P.slice(C).toLowerCase()}function Ge(R){const P=qe(R);if(P===".ts")return"ts";if(P===".tsx")return"tsx";if(P===".js")return"js";if(P===".jsx")return"jsx";if(P===".css")return"css";if(P===".json")return"json";throw new Error(`Unsupported Preview Project file type: ${P||"(no extension)"} (${R})`)}function Je(R){const P=ve(R),C=P.lastIndexOf("/");return C<=0?"/":P.slice(0,C)}function Ye(R,P,C="/"){const D=P.startsWith("/")?ve(P):mt(C==="/"?"/":Je(C),P),oe=(Fe.includes(qe(D))?[D]:[D,...Fe.map(ie=>`${D}${ie}`),...Fe.map(ie=>`${D}/index${ie}`)]).find(ie=>Object.prototype.hasOwnProperty.call(R,ie));if(!oe)throw new Error(`Cannot resolve "${P}" from "${C}" in Preview Project.`);return oe}function vt(R){return{name:"preview-virtual-fs",setup(P){P.onResolve({filter:/.*/},C=>{try{return yt(C.path)?{path:wt(C.path),namespace:"preview-runtime-dependency"}:{path:Ye(R(),C.path,C.importer||"/"),namespace:"preview-vfs"}}catch(D){return{errors:[{text:D instanceof Error?D.message:String(D)}]}}}),P.onLoad({filter:/.*/,namespace:"preview-vfs"},C=>{try{const D=R()[C.path];return D===void 0?{errors:[{text:`Virtual file not found: ${C.path}`}]}:{contents:D,loader:Ge(C.path),resolveDir:Je(C.path)}}catch(D){return{errors:[{text:D instanceof Error?D.message:String(D)}]}}}),P.onLoad({filter:/.*/,namespace:"preview-runtime-dependency"},C=>{const D="globalThis.__GOR_PREVIEW_RUNTIME__",X={three:`module.exports = ${D}.THREE;`,react:`const React = ${D}.React;
export default React;
export const { Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, cloneElement, createContext, createElement, createFactory, createRef, forwardRef, isValidElement, lazy, memo, startTransition, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = React;`,"react-dom":`const ReactDOM = ${D}.ReactDOM;
export default ReactDOM;
export const { createPortal, flushSync, findDOMNode, hydrate, render, unmountComponentAtNode, version } = ReactDOM;`,"react-dom/client":`const ReactDOMClient = ${D}.ReactDOMClient;
export default ReactDOMClient;
export const { createRoot, hydrateRoot, version } = ReactDOMClient;`,"react/jsx-runtime":`const runtime = ${D}.jsxRuntime;
export const { Fragment, jsx, jsxs } = runtime;`,"react/jsx-dev-runtime":`const runtime = ${D}.jsxDevRuntime;
export const { Fragment, jsxDEV } = runtime;`}[C.path];return X?{contents:X,loader:"js"}:{errors:[{text:`Unsupported runtime dependency: ${C.path}`}]}})}}}let Pe=null;function He(){return Pe||(Pe=We.initialize({wasmURL:dt,worker:!1}).catch(R=>{throw Pe=null,R})),Pe}function bt(R){if(R.endsWith(".js"))return"js";if(R.endsWith(".css"))return"css";throw new Error(`Unexpected build output type: ${R}`)}async function xt(R,P,C,D){await He();const Q=performance.now(),X=ve(D);Ye(C,X),Ge(X);const oe=await We.build({entryPoints:[X],bundle:!0,write:!1,outdir:"/out",entryNames:"bundle",format:"iife",globalName:"__GOR_PREVIEW_BUNDLE__",platform:"browser",jsx:"automatic",sourcemap:!1,logLevel:"silent",plugins:[vt(()=>C)]});return{buildId:P,projectId:R,entryPoint:X,outputFiles:(oe.outputFiles??[]).map(ie=>({path:ie.path.replace(/\\/g,"/"),type:bt(ie.path),contents:ie.text})),warnings:ze(oe.warnings),duration:performance.now()-Q}}const Ke=self;let $e=null,Te={};function ge(R){Ke.postMessage(R)}Ke.onmessage=async R=>{const P=R.data;try{if(P.type==="INIT"){await He(),ge({type:"READY",requestId:P.requestId});return}if(P.type==="RESET"){$e=null,Te={},ge({type:"FILES_SYNCED",requestId:P.requestId,projectId:null,fileCount:0});return}if(P.type==="SYNC_FILES"){$e=P.projectId,Te=structuredClone(P.files),ge({type:"FILES_SYNCED",requestId:P.requestId,projectId:$e,fileCount:Object.keys(Te).length});return}ge({type:"BUILD_STARTED",requestId:P.requestId,projectId:P.projectId,buildId:P.buildId});const C=performance.now();if($e!==P.projectId)throw new Error(`Preview Project "${P.projectId}" is not synchronized with the compiler Worker.`);try{const D=await xt(P.projectId,P.buildId,Te,P.entryPoint);ge({type:"BUILD_SUCCESS",requestId:P.requestId,result:D})}catch(D){ge({type:"BUILD_ERROR",requestId:P.requestId,projectId:P.projectId,buildId:P.buildId,diagnostics:gt(D),duration:performance.now()-C})}}catch(C){ge({type:"WORKER_ERROR",requestId:P.requestId,message:C instanceof Error?C.message:String(C)})}}})();
