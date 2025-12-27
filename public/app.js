// Simple frontend to register/login and request pairing codes.
// Uses Fetch + Socket.IO to receive pairing updates.

let token = localStorage.getItem("cm_token");
let user = JSON.parse(localStorage.getItem("cm_user") || "null");

const el = id => document.getElementById(id);

function setUser(u) {
  user = u;
  localStorage.setItem("cm_user", JSON.stringify(u));
  el("user-info").style.display = u ? "block" : "none";
  if (u) {
    el("user-email").textContent = u.email;
    el("user-coins").textContent = u.coins ?? 0;
  }
}

setUser(user);

if (token) {
  // optionally refresh user info
}

el("btn-register").addEventListener("click", async () => {
  const email = el("reg-email").value.trim();
  const password = el("reg-pass").value.trim();
  if (!email || !password) return alert("email & password");
  const res = await fetch("/api/register", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ email, password })});
  const data = await res.json();
  if (res.ok) {
    token = data.token;
    localStorage.setItem("cm_token", token);
    setUser(data.user);
    alert("Registered");
  } else {
    alert(data.error || JSON.stringify(data));
  }
});

el("btn-login").addEventListener("click", async () => {
  const email = el("login-email").value.trim();
  const password = el("login-pass").value.trim();
  if (!email || !password) return alert("email & password");
  const res = await fetch("/api/login", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ email, password })});
  const data = await res.json();
  if (res.ok) {
    token = data.token;
    localStorage.setItem("cm_token", token);
    setUser(data.user);
    alert("Logged in");
    loadSessions();
  } else {
    alert(data.error || JSON.stringify(data));
  }
});

el("btn-logout").addEventListener("click", () => {
  token = null; localStorage.removeItem("cm_token"); localStorage.removeItem("cm_user"); setUser(null);
});

el("btn-pair").addEventListener("click", async () => {
  if (!token) return alert("Please login first");
  const phoneNumber = el("phoneNumber").value.trim();
  if (!phoneNumber) return alert("Enter phone number digits only");
  const res = await fetch("/api/create-pair", { method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${token}` }, body: JSON.stringify({ phoneNumber })});
  const data = await res.json();
  if (!res.ok) return alert(data.error || JSON.stringify(data));
  const sessionId = data.sessionId;
  el("pairingStatus").textContent = "Pairing started...";
  el("pairingCode").textContent = "";
  // Connect to namespace socket
  const ns = io(`/pair/${sessionId}`);
  ns.on("connect", () => {
    console.log("connected to pair namespace", sessionId);
  });
  ns.on("pairing.code", (d) => {
    el("pairingCode").textContent = d.pairingCode || "N/A";
    el("pairingStatus").textContent = "Enter this pairing code in WhatsApp > Linked Devices > Link a device";
  });
  ns.on("pairing.update", (u) => {
    el("pairingStatus").textContent = JSON.stringify(u);
  });
  ns.on("pairing.connected", (u) => {
    el("pairingStatus").textContent = "Connected!";
    setTimeout(loadSessions, 1000);
  });
  ns.on("pairing.error", (err) => {
    el("pairingStatus").textContent = "Error: " + (err.message || JSON.stringify(err));
  });
  ns.on("pairing.closed", (c) => {
    el("pairingStatus").textContent = "Closed: " + JSON.stringify(c);
  });
});

async function loadSessions() {
  if (!token) return;
  const res = await fetch("/api/sessions", { headers: { authorization: `Bearer ${token}` }});
  const data = await res.json();
  if (res.ok) {
    const ul = el("sessionsList");
    ul.innerHTML = "";
    (data.sessions || []).forEach(s => {
      const li = document.createElement("li");
      li.innerHTML = `<div><strong>${s.phoneNumber}</strong> — ${s.status}</div><div><button data-id="${s.id}" class="cmd-btn">Send .ping</button></div>`;
      ul.appendChild(li);
    });
    document.querySelectorAll(".cmd-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = btn.dataset.id;
        const res = await fetch(`/api/sessions/${id}/command`, { method: "POST", headers: { "content-type":"application/json", "authorization": `Bearer ${token}` }, body: JSON.stringify({ commandText: ".ping" })});
        const d = await res.json();
        alert(JSON.stringify(d));
      });
    });
  }
}

loadSessions();
