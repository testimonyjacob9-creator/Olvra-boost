// public/js/info-carousel.js
// "Learn how this works" info modal — extracted from the inline copy in
// index.html (kept there too, single-file-upload reasons — see
// catalog-config.js). Any page can call openInfoCarousel(); the required
// CSS is injected once on first use so pages don't need to hand-copy it.

const IC_TOPICS = [
  {
    icon: "⏱️", title: "How Delivery Works", subtitle: "Speed depends on the service you choose",
    body: `<ul class="ic-list">
      <li><b>Fast services</b> — usually complete within minutes to a couple of hours.</li>
      <li><b>Standard services</b> — anywhere from seconds to a few days depending on demand.</li>
      <li>Every service card shows an estimated speed before you order.</li>
      <li>Orders are routed to protect the account being promoted, and are usually cheaper than rushed delivery.</li>
    </ul>`,
  },
  {
    icon: "🛡️", title: "Smart Tips Before You Start", subtitle: null,
    body: `<div class="ic-tag ic-tag-red">▾ LQ — Low Quality</div>
      <p class="ic-p">Cheap and unstable. Followers, likes, or views can drop to zero over time. Best for testing — avoid on accounts you care about.</p>
      <div class="ic-tag ic-tag-green">⚡ HQ — High Quality</div>
      <p class="ic-p">Stable, with much better retention. Recommended for real campaigns and client work.</p>
      <div class="ic-tag ic-tag-amber">👁 Stay Alert</div>
      <p class="ic-p">Avoid overtly cheap services. Don't use an untested service on an account you care about. Check order status regularly — test small, then scale.</p>`,
  },
  {
    icon: "🔎", title: "Smart Ordering", subtitle: "Find the best service before spending big",
    body: `<p class="ic-p">Want 1,000 followers? Don't order it all in one go. Here's a safer way:</p>
      <ol class="ic-steps">
        <li><b>Pick a few services that look good</b> — check retention notes, price, and speed.</li>
        <li><b>Order a small test batch from each</b> — e.g. 50 from each of 5 options.</li>
        <li><b>Scale up on whichever delivered fastest and cleanest.</b></li>
      </ol>
      <p class="ic-p ic-highlight">This saves time and money — you only scale what actually works.</p>`,
  },
  {
    icon: "🔄", title: "Auto Services", subtitle: "Set it once, it works on every new post",
    body: `<p class="ic-p">Auto Likes, Comments, and Views watch your profile and automatically deliver to every new post you publish.</p>
      <ul class="ic-list">
        <li>You enter your <b>username</b>, not a post link.</li>
        <li>Every time you post, engagement arrives automatically.</li>
        <li>You can also apply it to your last few existing posts.</li>
        <li>Runs until it expires, hits its post limit, or you cancel it.</li>
      </ul>
      <p class="ic-p ic-highlight">Perfect if you post regularly and want consistent engagement without ordering every time.</p>`,
  },
  {
    icon: "⚠️", title: "Delivery Expectations", subtitle: null,
    body: `<ul class="ic-list">
      <li>Delivery can be fast (minutes) or slow (days) — this varies by service and demand.</li>
      <li>Some orders complete fully, some partially — whatever doesn't deliver is refunded automatically.</li>
      <li>A service can show "Completed" and later drop — that's when Refill (where supported) helps.</li>
    </ul>
    <p class="ic-p">Check your Orders page first if something looks off — most issues resolve automatically. Contact support after 48 hours.</p>`,
  },
];

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .ic-overlay{ position:fixed; inset:0; background:rgba(16,22,54,0.55); z-index:70;
      display:flex; align-items:flex-end; justify-content:center; }
    .ic-modal{ background:#FFFFFF; border-radius:22px 22px 0 0; width:100%; max-width:460px;
      padding:22px 22px 20px; max-height:90vh; overflow-y:auto; position:relative;
      font-family:'Inter', -apple-system, sans-serif; }
    .ic-close{ position:absolute; top:16px; right:16px; width:32px; height:32px; border-radius:50%;
      background:#EEF3FF; border:none; color:#6B7590; font-size:16px; cursor:pointer; }
    .ic-dots{ display:flex; gap:6px; justify-content:center; margin-bottom:16px; }
    .ic-dot{ width:22px; height:4px; border-radius:3px; background:#D8DEF2; cursor:pointer; }
    .ic-dot.active{ background:#2C5CF6; }
    .ic-icon{ font-size:32px; text-align:center; margin-bottom:8px; }
    .ic-title{ font-size:17px; font-weight:700; text-align:center; margin:0 0 2px; color:#10162B; }
    .ic-subtitle{ font-size:12.5px; text-align:center; color:#6B7590; margin:0 0 14px; }
    .ic-list{ margin:0 0 4px; padding-left:18px; font-size:13.5px; line-height:1.6; color:#10162B; }
    .ic-list li{ margin-bottom:8px; }
    .ic-steps{ margin:8px 0; padding-left:18px; font-size:13.5px; line-height:1.6; color:#10162B; }
    .ic-steps li{ margin-bottom:10px; }
    .ic-p{ font-size:13.5px; line-height:1.6; margin:0 0 10px; color:#10162B; }
    .ic-highlight{ background:#EEF3FF; color:#1339B0; border-radius:12px; padding:10px 12px; font-weight:600; }
    .ic-tag{ display:inline-block; font-size:11.5px; font-weight:700; padding:4px 10px; border-radius:8px; margin-bottom:6px; }
    .ic-tag-red{ background:#FDECEC; color:#E5484D; }
    .ic-tag-green{ background:#E7F9F1; color:#12B76A; }
    .ic-tag-amber{ background:#FFF4E5; color:#B7791F; }
    .ic-btn-row{ display:flex; gap:10px; margin-top:18px; }
    .ic-btn-row .btn{ padding:14px; border-radius:12px; border:none; font-weight:700; font-size:14px; cursor:pointer; font-family:inherit; }
    .ic-btn-row .btn-primary{ background:linear-gradient(135deg,#2C5CF6,#1339B0); color:#fff; }
    .ic-btn-row .btn-ghost{ background:#EEF3FF; color:#1339B0; }
  `;
  document.head.appendChild(style);
}

export function openInfoCarousel() {
  injectStyles();
  const overlay = document.createElement("div");
  overlay.className = "ic-overlay";
  const modal = document.createElement("div");
  modal.className = "ic-modal";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  function close() { document.body.removeChild(overlay); }

  function render(index) {
    const t = IC_TOPICS[index];
    const isFirst = index === 0, isLast = index === IC_TOPICS.length - 1;
    modal.innerHTML = `
      <button class="ic-close" id="ic-x">✕</button>
      <div class="ic-dots">${IC_TOPICS.map((_, i) => `<div class="ic-dot ${i === index ? "active" : ""}" data-i="${i}"></div>`).join("")}</div>
      <div class="ic-icon">${t.icon}</div>
      <h2 class="ic-title">${t.title}</h2>
      ${t.subtitle ? `<p class="ic-subtitle">${t.subtitle}</p>` : ""}
      ${t.body}
      <div class="ic-btn-row">
        ${!isFirst ? `<button class="btn btn-ghost" style="flex:0 0 auto; padding:14px 18px;" id="ic-back">Back</button>` : ""}
        <button class="btn btn-primary" style="flex:1;" id="ic-next">${isLast ? "Done" : "Next"}</button>
      </div>`;
    modal.querySelector("#ic-x").onclick = close;
    modal.querySelectorAll(".ic-dot").forEach((d) => { d.onclick = () => render(Number(d.dataset.i)); });
    const back = modal.querySelector("#ic-back");
    if (back) back.onclick = () => render(index - 1);
    modal.querySelector("#ic-next").onclick = () => { if (isLast) close(); else render(index + 1); };
  }
  render(0);
}
