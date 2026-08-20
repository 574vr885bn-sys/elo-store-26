let products=[],cart=JSON.parse(localStorage.getItem("eloCart")||"[]"),couponData=null,lastOrder=null;
const $=s=>document.querySelector(s);
const money=n=>"R$ "+Number(n).toFixed(2).replace(".",",");
async function api(url,opt={}){const r=await fetch(url,opt);const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Ocorreu um erro.");return d}
async function init(){products=await api("/api/products");renderProducts();renderCart();renderReviews();loadPayments();loadSiteConfig()}
function renderProducts(){
 const q=($("#search")?.value||"").toLowerCase();
 const list=products.filter(p=>p.name.toLowerCase().includes(q));
 $("#products").innerHTML=list.map(p=>`<article class="product ${!p.available?"soldout":""}">
 <button class="product-open" onclick="showProduct(${p.id})"><div class="product-icon">💎</div><span class="stock ${p.available?"ok":""}">${p.available?"Disponível":"Esgotado"}</span><h3>${p.name}</h3><p>${p.description}</p></button>
 <div class="product-bottom"><span class="price">${money(p.price)}</span><button class="add" ${!p.available?"disabled":""} onclick="add(${p.id})">${p.available?"Comprar":"Esgotado"}</button></div></article>`).join("")||"<p class='muted-text'>Nenhum produto encontrado.</p>";
}
function add(id){const p=products.find(x=>x.id===id);if(!p?.available)return;const x=cart.find(x=>x.id===id);x?x.qty++:cart.push({id,qty:1});saveCart();openCart()}
function remove(id){cart=cart.filter(x=>x.id!==id);saveCart()}
function change(id,d){const x=cart.find(x=>x.id===id);if(!x)return;x.qty+=d;if(x.qty<=0)remove(id);else saveCart()}
function saveCart(){localStorage.setItem("eloCart",JSON.stringify(cart));renderCart()}
function renderCart(){let total=0,count=0;$("#cartItems").innerHTML=cart.length?cart.map(x=>{const p=products.find(p=>p.id===x.id);if(!p)return"";const sub=p.price*x.qty;total+=sub;count+=x.qty;return `<div class="cart-row"><div class="grow"><b>${p.name}</b><div class="small">${money(sub)}</div></div><div class="qty"><button onclick="change(${p.id},-1)">−</button><span>${x.qty}</span><button onclick="change(${p.id},1)">+</button></div></div>`}).join(""):"<div class='empty'>O teu carrinho está vazio.</div>";$("#cartCount").textContent=count;$("#cartTotal").textContent=money(total);$("#checkoutTotal").textContent=money(total)}
function openCart(){$("#drawer").classList.add("open");$("#overlay").classList.add("show")}
function closeCart(){$("#drawer").classList.remove("open");$("#overlay").classList.remove("show")}
function closeAll(){closeCart()}
function showProduct(id){const p=products.find(x=>x.id===id);if(!p)return;$("#productDetails").innerHTML=`<div class="eyebrow">PRODUTO</div><h2>${p.name}</h2><p>${p.description}</p><div class="info-box">${p.info}</div><div class="product-detail-price">${money(p.price)}</div><p class="stockline">${p.available?"✓ Disponível":"✕ Esgotado"}</p><button class="btn primary full" ${!p.available?"disabled":""} onclick="add(${p.id});closeModal('productModal')">Comprar agora</button>`;openModal("productModal")}
function openCheckout(){if(!cart.length)return alert("Adiciona pelo menos um produto.");closeCart();openModal("paymentModal")}
function continueAfterPayment(){closeModal("paymentModal");requestAnimationFrame(()=>openModal("checkoutModal"))}
function openModal(id){$("#"+id).classList.add("show")}
function closeModal(id){$("#"+id).classList.remove("show")}
async function loadPayments(){try{const c=await api("/api/config");$("#pixKey").textContent=c.pix;$("#paypalEmail").textContent=c.paypal}catch{}}
function copyValue(id){navigator.clipboard?.writeText($("#"+id).textContent);alert("Copiado!")}
async function applyCoupon(){const code=$("#coupon").value.trim();if(!code)return;try{couponData=await api("/api/coupon",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});$("#couponMsg").textContent=`Código aplicado: -${couponData.discountPercent}%`;updateCheckoutTotal()}catch(e){couponData=null;$("#couponMsg").textContent=e.message}}
function updateCheckoutTotal(){let t=cart.reduce((s,x)=>{const p=products.find(p=>p.id===x.id);return s+(p?p.price*x.qty:0)},0);if(couponData)t-=t*couponData.discountPercent/100;$("#checkoutTotal").textContent=money(t)}
$("#checkoutForm").addEventListener("submit",async e=>{e.preventDefault();const fd=new FormData(e.target);const first=cart[0];if(!first)return;fd.append("productId",first.id);fd.append("quantity",first.qty);if(couponData)fd.append("coupon",couponData.code);try{const d=await api("/api/orders",{method:"POST",body:fd});lastOrder=d.order;cart=[];saveCart();e.target.reset();couponData=null;closeModal("checkoutModal");$("#successTitle").textContent=d.order.order_number;$("#successText").innerHTML=`Pedido criado com sucesso.<br><b>${d.order.product_name}</b> · ${money(d.order.total)}<br>Estado: <b>${d.order.status}</b>`;openModal("successModal");products=await api("/api/products");renderProducts()}catch(err){alert(err.message)}});
async function openTicketFromSuccess(){if(!lastOrder)return;try{const d=await api(`/api/orders/${lastOrder.order_number}/ticket`,{method:"POST"});alert("Ticket criado no Discord: "+d.channelId)}catch(e){alert(e.message)}}
async function lookupOrder(){const n=$("#lookupNumber").value.trim().toUpperCase();if(!n)return;try{const o=await api("/api/orders/"+encodeURIComponent(n));$("#lookupResult").innerHTML=`<div class="lookup-card"><b>${o.order_number}</b><span>${o.product_name} ×${o.quantity}</span><span>Total: ${money(o.total)}</span><span>Estado: <strong>${o.status}</strong></span><span>Atualizado: ${new Date(o.updated_at.replace(" ","T")).toLocaleString("pt-PT")}</span><button class="btn secondary" onclick="createTicket('${o.order_number}')">Criar ticket</button></div>`}catch(e){$("#lookupResult").innerHTML=`<p class="error">${e.message}</p>`}}
async function createTicket(n){try{const d=await api(`/api/orders/${n}/ticket`,{method:"POST"});alert("Ticket criado: "+d.channelId)}catch(e){alert(e.message)}}
function openOrderLookup(){openModal("lookupModal")}
async function renderReviews(){try{const r=await api("/api/reviews");$("#reviews").innerHTML=r.length?r.map(x=>`<article class="review"><div>${"★".repeat(x.rating)}${"☆".repeat(5-x.rating)}</div><b>${escapeHtml(x.name)}</b><p>${escapeHtml(x.text)}</p></article>`).join(""):"<p class='muted-text'>Ainda não existem avaliações.</p>"}catch{}}
function openReview(){openModal("reviewModal")}
$("#reviewForm").addEventListener("submit",async e=>{e.preventDefault();try{await api("/api/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});alert("Avaliação enviada!");e.target.reset();closeModal("reviewModal");renderReviews()}catch(err){alert(err.message)}})
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
init().catch(e=>alert(e.message));

async function loadSiteConfig(){
  try{
    const s=await api("/api/site-config");
    if(!s.announcementEnabled || !s.announcements?.length)return;
    const a=s.announcements[0];
    const bar=$("#siteAnnouncement");
    $("#announcementTitle").textContent=a.title;
    $("#announcementMessage").textContent=" — "+a.message;
    const icons={info:"📢",success:"✅",warning:"⚠️",danger:"🚨"};
    $("#announcementIcon").textContent=icons[a.type]||"📢";
    bar.classList.remove("hidden");
    bar.classList.add(a.type);
  }catch{}
}
function hideAnnouncement(){localStorage.setItem("eloAnnouncementHidden","1");$("#siteAnnouncement")?.classList.add("hidden")}
