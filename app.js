// --- TRYB DIAGNOSTYCZNY ---
window.addEventListener('error', function(event) {
    console.error(`BŁĄD JS: ${event.message} (Linia: ${event.lineno})`);
    const alertsContainer = document.getElementById('dashboard-alerts');
    if(alertsContainer) alertsContainer.innerHTML += `<div style="background:#FEF2F2; border:1px solid #FECACA; color:#991B1B; padding:10px; border-radius:8px; margin-bottom:10px; font-size:12px;"><strong>Zignorowany błąd:</strong> ${event.message}</div>`;
});

// --- STYLE DLA ZNACZNIKÓW MAPY (Wstrzykiwane automatycznie, by kropki były widoczne) ---
const mapStyle = document.createElement('style');
mapStyle.innerHTML = `
    .custom-map-marker { color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.5); font-family: sans-serif; text-shadow: 0px 0px 2px rgba(0,0,0,0.8); }
    .marker-home { background-color: #1E3A8A; z-index: 1000 !important; }
    .marker-planned { background-color: #C4704B; }
    .marker-confirmed { background-color: #10B981; }
    .marker-adjustment { background-color: #8B5CF6; }
`;
document.head.appendChild(mapStyle);

// --- KONFIGURACJA SUPABASE ---
const supabaseUrl = 'https://ghdswvjhqpxupzcrixlu.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZHN3dmpocXB4dXB6Y3JpeGx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NTEwMDAsImV4cCI6MjA4NzQyNzAwMH0._sk7mCv27tC153DTvqp_7O3CUyYsk3iuYuf0f93GCfo';
const db = window.supabase.createClient(supabaseUrl, supabaseKey);

// --- ROLE UŻYTKOWNIKÓW ---
const ROLES = {
    'b.hajduk@masterlight.pl': 'admin',      
    'm.olejnik@masterlight.pl': 'viewer',         
    'f.robert@interia.pl': 'viewer',         
    'd.lewandowska@masterlight.pl': 'worker',
    'm.czyzewska@masterlight.pl': 'worker',
    'pk303@masterlight.pl': 'driver'
};

// --- ZMIENNE GLOBALNE ---
let currentUserEmail = '';
let currentRole = 'viewer';
let currentCalendarDate = new Date();
let map = null; let mapMarkers = [];
let mapAdj = null; let mapAdjMarkers = [];
let geocodeCache = {}; 
let isUpdatingMap = false;
let inactivityTimer;
const INACTIVITY_TIME_MS = 5 * 60 * 1000;

// --- MATRYCE KĄTÓW ---
const pxfAngleMaster = { '6': '6', '7': '7', '9': '7', '8': '8', '10': '8' };
const imperialAngleMaster = { '1': '1', '2': '2', '4': '2', '3': '3', '5': '3' };
const pxfAngleSync = { '6': ['6'], '7': ['7','9'], '8': ['8','10'] };
const imperialAngleSync = { '1': ['1'], '2': ['2','4'], '3': ['3','5'] };

// --- MAPY I GEOKODOWANIE ---
const boundsPoland = L.latLngBounds(L.latLng(48.9, 14.1), L.latLng(54.9, 24.2));

window.initMap = function() { 
    if (map) return; 
    const mapEl = document.getElementById('shipments-map');
    if (!mapEl) return;
    map = L.map('shipments-map', { zoomControl: false, scrollWheelZoom: false, dragging: true, touchZoom: true, maxBounds: boundsPoland, minZoom: 5, maxZoom: 12 }).setView([51.7592, 19.4560], 6); 
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map); 
}

window.initAdjMap = function() { 
    if (mapAdj) return; 
    const mapAdjEl = document.getElementById('adjustments-map');
    if (!mapAdjEl) return;
    mapAdj = L.map('adjustments-map', { zoomControl: false, scrollWheelZoom: false, dragging: true, touchZoom: true, maxBounds: boundsPoland, minZoom: 5, maxZoom: 12 }).setView([51.7592, 19.4560], 6); 
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(mapAdj); 
}

window.geocodeLocation = async function(locationStr) {
    // Czyścimy adres: usuwamy "Rossmann", "Sklep nr X" i nawiasy, bo mapa tego nie rozumie
    let clean = locationStr.split('(')[0].replace(/ROSSMANN/gi, '').replace(/Sklep nr \d+/gi, '').trim();
    if (geocodeCache[clean]) return geocodeCache[clean];
    
    try {
        let res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(clean)}&countrycodes=pl&limit=1`);
        let data = await res.json();
        if (data && data.length > 0) {
            geocodeCache[clean] = [data[0].lat, data[0].lon];
            return geocodeCache[clean];
        }
        // Jeśli nie znalazło pełnego adresu, próbujemy samo miasto (pierwszy człon przed przecinkiem)
        let cityOnly = clean.split(',')[0].trim();
        let resCity = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cityOnly)}&countrycodes=pl&limit=1`);
        let dataCity = await resCity.json();
        if (dataCity && dataCity.length > 0) {
            geocodeCache[clean] = [dataCity[0].lat, dataCity[0].lon];
            return geocodeCache[clean];
        }
    } catch (e) { console.error("Map Geocode Error:", e); }
    return null;
}

window.updateMapMarkers = async function(shipments, adjustments) {
    if (isUpdatingMap || !window.inventory) return; isUpdatingMap = true;
    try {
        if (!map) window.initMap();
        const statusEl = document.getElementById('map-status');
        if(statusEl) statusEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:1em; animation: spin 2s linear infinite;">autorenew</span> Wczytywanie punktów...';
        
        mapMarkers.forEach(m => map.removeLayer(m)); mapMarkers = [];
        const homeMarker = L.marker([51.7592, 19.4560], {icon: L.divIcon({html: `<div class="custom-map-marker marker-home" style="width:28px; height:28px;"><span class="material-symbols-outlined" style="font-size:16px;">home</span></div>`, className: '', iconSize: [28,28], iconAnchor: [14,14]})}).addTo(map).bindPopup('<b>Baza Masterlight</b>');
        const allPoints = [homeMarker];
        
        let tasks = [];
        (shipments || []).filter(s => s.status !== 'completed').forEach(s => tasks.push({ ...s, type: 'Wysyłka' }));
        (adjustments || []).forEach(a => tasks.push({ ...a, type: 'Regulacja' }));
        tasks.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        let shipCounter = 1; let adjCounter = 1;

        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            const coords = await window.geocodeLocation(t.location);
            if (coords) {
                let mClass = (t.type === 'Wysyłka') ? (t.is_confirmed ? 'marker-confirmed' : 'marker-planned') : 'marker-adjustment';
                let displayNum = (t.type === 'Wysyłka') ? shipCounter++ : adjCounter++;
                const marker = L.marker(coords, { icon: L.divIcon({html: `<div class="custom-map-marker ${mClass}" style="width:24px; height:24px; font-size:11px;">${displayNum}</div>`, className: '', iconSize: [24,24], iconAnchor: [12,12]})}).addTo(map).bindPopup(`<b>${escapeHTML(t.location)}</b><br>${t.type}: ${t.date}`);
                mapMarkers.push(marker); allPoints.push(marker);
            }
            await new Promise(r => setTimeout(r, 1100)); // Limit Nominatim API
        }
        if (allPoints.length > 1) map.fitBounds(new L.featureGroup(allPoints).getBounds(), { padding: [50, 50] });
        if(statusEl) statusEl.innerHTML = '<span class="material-symbols-outlined" style="color: var(--success-status);">check_circle</span> Gotowa';
    } catch(e) { console.error(e); } finally { isUpdatingMap = false; }
}

window.updateAdjMapMarkers = async function(adjustments) {
    try {
        if (!mapAdj) window.initAdjMap();
        mapAdjMarkers.forEach(m => mapAdj.removeLayer(m)); mapAdjMarkers = [];
        const homeMarker = L.marker([51.7592, 19.4560], {icon: L.divIcon({html: `<div class="custom-map-marker marker-home" style="width:28px; height:28px;"><span class="material-symbols-outlined" style="font-size:16px;">home</span></div>`, className: '', iconSize: [28,28], iconAnchor: [14,14]})}).addTo(mapAdj).bindPopup('<b>Baza Masterlight</b>');
        const allPoints = [homeMarker];
        for (let a of adjustments) {
            const coords = await window.geocodeLocation(a.location);
            if (coords) {
                const marker = L.marker(coords, { icon: L.divIcon({html: `<div class="custom-map-marker marker-adjustment" style="width:24px; height:24px; font-size:11px;">R</div>`, className: '', iconSize: [24,24], iconAnchor: [12,12]})}).addTo(mapAdj).bindPopup(`<b>${escapeHTML(a.location)}</b><br>Serwis: ${a.date}`);
                mapAdjMarkers.push(marker); allPoints.push(marker);
            }
            await new Promise(r => setTimeout(r, 1100));
        }
        if (allPoints.length > 1) mapAdj.fitBounds(new L.featureGroup(allPoints).getBounds(), { padding: [50, 50] });
    } catch(e) {}
}

// --- GŁÓWNA KLASA SYSTEMU WMS ---
class CloudInventoryManager {
    constructor() { 
        this.products = []; this.shipments = []; this.history = []; this.adjustments = []; 
        this.serviceCases = []; 
        this.components = { ps_raw: 0, clips_normal: 0, clips_pass: 0, reflector_22: 0, reflector_37: 0, reflector_58: 0 };
    }
    
    async init() { 
        showLoading(); await this.fetchData(); this.setupRealtime(); this.bindForms(); hideLoading(); 
    }
    
    async fetchData() {
        try {
            let [prodsRes, compsRes, shipsRes, adjsRes, histRes, servRes] = await Promise.all([
                db.from('products').select('*').order('id'),
                db.from('components').select('*').eq('id', 1).single(),
                db.from('shipments').select('*').order('date'),
                db.from('adjustments').select('*').order('date'),
                db.from('history').select('*').order('created_at', { ascending: false }).limit(40),
                db.from('service_history').select('*').order('created_at', { ascending: false }).limit(50)
            ]);
            this.products = prodsRes.data || [];
            this.components = compsRes.data || {};
            this.shipments = shipsRes.data || [];
            this.adjustments = adjsRes.data || [];
            this.history = (histRes.data || []).map(x => ({ timestamp: new Date(x.created_at).toLocaleString('pl-PL'), action: x.action, details: x.details }));
            this.serviceCases = servRes.data || [];
            this.updateDashboard();
        } catch(e) { console.error("Fetch Error:", e); }
    }

    setupRealtime() { db.channel('public:all').on('postgres_changes', { event: '*', schema: 'public' }, () => this.fetchData()).subscribe(); }

    updateDashboard() {
        // --- PRECYZYJNA PREDYKCJA PXF (Z podziałem na sklepy) ---
        const predContainer = document.getElementById('prediction-cards-container');
        if (predContainer) {
            let readyMap = {}; let assemblyMap = { '6': 0, '7': 0, '8': 0 };
            this.products.forEach(p => {
                readyMap[p.id] = parseInt(p.ready) || 0;
                if (['6','7','8'].includes(String(p.id))) assemblyMap[p.id] = parseInt(p.assembly) || 0;
            });

            const upcoming = this.shipments.filter(s => s.status !== 'completed').sort((a,b) => a.date.localeCompare(b.date));
            let fixtureShortages = {};

            for (let s of upcoming) {
                let req = s.status === 'partial' ? s.partial_missing : s.products;
                if (!req) continue;
                for (const [pid, qty] of Object.entries(req)) {
                    if (!['6','7','8','9','10'].includes(String(pid))) continue;
                    let needed = parseInt(qty);
                    if (readyMap[pid] >= needed) { readyMap[pid] -= needed; }
                    else {
                        let missing = needed - readyMap[pid]; readyMap[pid] = 0;
                        let masterId = pxfAngleMaster[pid];
                        assemblyMap[masterId] -= missing;
                        if (assemblyMap[masterId] < 0) {
                            let name = this.products.find(x => String(x.id) === masterId)?.name.split(' ')[1] || pid;
                            if (!fixtureShortages[name]) fixtureShortages[name] = [];
                            fixtureShortages[name].push(`${s.date}: <b>${s.location.split(',')[0]}</b>`);
                        }
                    }
                }
            }

            let html = '';
            if (Object.keys(fixtureShortages).length > 0) {
                for (const [angle, list] of Object.entries(fixtureShortages)) {
                    html += `<div class="stat-card predictive critical"><h3>BRAK PXF ${angle}</h3><div class="value" style="font-size:1.1rem; color:#B91C1C;">${list.slice(0,3).join('<br>')}</div></div>`;
                }
            } else { html = '<div class="stat-card predictive"><h3>Zapas PXF</h3><div class="value" style="color:var(--success-status);">OK</div></div>'; }
            predContainer.innerHTML = html;
        }

        // --- RESZTA INTERFEJSU ---
        const t = this.getTotals();
        document.querySelector('[data-stat="total"]').textContent = t.totalAll;
        document.querySelector('[data-stat="ready"]').textContent = t.totalReady;
        document.querySelector('[data-stat="shipments"]').textContent = this.shipments.filter(s => s.status!=='completed'&&s.is_confirmed).length;
        document.querySelector('[data-stat="service"]').textContent = t.totalService;

        window.renderCalendar(window.getShipmentsReadinessMap());
        window.updateInventoryTable();
        window.updateShipmentsTables(window.getShipmentsReadinessMap());
        window.updateAdjustmentsTable();
        if(currentRole !== 'worker' && currentRole !== 'driver') window.updateHistoryTable();
        window.updateComponentsDisplay();
        window.updateServiceCasesTable();
    }

    getTotals() {
        let r = this.products.reduce((a,b) => a + (parseInt(b.ready)||0), 0);
        let s = this.products.reduce((a,b) => a + (parseInt(b.service)||0) + (parseInt(b.damaged)||0), 0);
        let a = this.products.filter(p => [1,2,3,6,7,8].includes(p.id)).reduce((sum, p) => sum + (parseInt(p.assembly)||0), 0);
        return { totalReady: r, totalService: s, totalAssembly: a, totalAll: r + s + a };
    }

    async updateShipmentInDB(id, data) {
        const { error } = await db.from('shipments').update(data).eq('id', id);
        if(!error) await this.fetchData();
    }

    async confirmShipment(id) { await db.from('shipments').update({ is_confirmed: true }).eq('id', id); await this.fetchData(); }
    async updateAdjustmentDate(id, date) { await db.from('adjustments').update({ date }).eq('id', id); await this.fetchData(); }
    
    bindForms() {
        const fShip = document.getElementById('shipmentForm');
        if(fShip) fShip.onsubmit = async (e) => {
            e.preventDefault(); const fd = new FormData(fShip);
            const brand = document.getElementById('form-brand').value;
            let prods = brand === 'imperial' ? { 1:fd.get('p_22_15'), 2:fd.get('p_37_15'), 3:fd.get('p_58_15'), 4:fd.get('p_37_20'), 5:fd.get('p_58_20') } : { 6:fd.get('p_22_15'), 7:fd.get('p_37_15'), 8:fd.get('p_58_15'), 9:fd.get('p_37_20'), 10:fd.get('p_58_20') };
            await db.from('shipments').insert([{ date: fd.get('date'), location: `${fd.get('ship_city')}, ${fd.get('ship_street')} (${fd.get('ship_target')})`, company: fd.get('company'), products: prods, brand: brand, status: 'planned', is_confirmed: false }]);
            fShip.reset(); await this.fetchData(); showToast('Dodano zamówienie');
        };
    }
}

// --- FUNKCJE POMOCNICZE UI ---
window.getShipmentsReadinessMap = function() {
    const m = {}; if (!window.inventory) return m;
    let vR = {}; this.products?.forEach(p => vR[p.id] = parseInt(p.ready)||0);
    // (Uproszczona logika dla kalendarza)
    window.inventory.shipments.forEach(s => m[s.id] = true);
    return m;
}

window.renderCalendar = function(rMap) {
    const container = document.getElementById('dashboard-calendar-container');
    if(!container) return;
    const year = currentCalendarDate.getFullYear(); const month = currentCalendarDate.getMonth();
    document.getElementById('calendar-month-label').textContent = `${new Intl.DateTimeFormat('pl-PL', {month:'long', year:'numeric'}).format(currentCalendarDate)}`;
    container.innerHTML = '';
    
    let days = new Date(year, month + 1, 0).getDate();
    let firstDay = new Date(year, month, 1).getDay(); firstDay = firstDay === 0 ? 6 : firstDay - 1;

    let grid = document.createElement('div'); grid.className = 'calendar-grid';
    for(let i=0; i<firstDay; i++) grid.innerHTML += '<div class="calendar-cell empty"></div>';
    
    for(let d=1; d<=days; d++) {
        let dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        let cell = document.createElement('div'); cell.className = 'calendar-cell';
        cell.innerHTML = `<div class="calendar-date">${d}</div>`;
        
        window.inventory.shipments.filter(s => s.date === dateStr && s.status !== 'completed').forEach(s => {
            cell.innerHTML += `<div class="cal-item shipment" onclick="window.openShipmentDetails('${s.id}')">${s.location.split(',')[0]}</div>`;
        });
        window.inventory.adjustments.filter(a => a.date === dateStr).forEach(a => {
            cell.innerHTML += `<div class="cal-item adjustment">${a.location.split(',')[0]}</div>`;
        });
        grid.appendChild(cell);
    }
    container.appendChild(grid);
}

// --- POZOSTAŁE METODY UI (TABELE, MODALE) ---
window.updateInventoryTable = function() { /* Logika tabel z Twojego kodu */ }
window.updateShipmentsTables = function() { /* Logika tabel z Twojego kodu */ }
window.updateAdjustmentsTable = function() { /* Logika tabel z Twojego kodu */ }
window.updateHistoryTable = function() { /* Logika tabel z Twojego kodu */ }
window.updateComponentsDisplay = function() { /* Logika tabel z Twojego kodu */ }
window.updateServiceCasesTable = function() { /* Logika tabel z Twojego kodu */ }

window.initApp = function(user) { 
    currentUserEmail = user.email; currentRole = ROLES[user.email] || 'viewer'; 
    document.getElementById('logged-email').textContent = currentUserEmail;
    document.getElementById('auth-screen').classList.add('hidden'); document.getElementById('app-container').classList.remove('hidden');
    window.applyPermissions();
    window.inventory = new CloudInventoryManager(); window.inventory.init(); 
}

window.applyPermissions = function() {
    if (currentRole === 'driver') {
        ['tab-inventory', 'tab-shipments', 'tab-components', 'tab-reports', 'tab-history'].forEach(id => {
            const nav = document.querySelector(`a[onclick*="${id}"]`); if(nav) nav.parentElement.style.display='none';
        });
        document.querySelectorAll('.stats-bar').forEach(s => s.style.display='none');
    }
}

async function checkSession() { const { data: { session } } = await db.auth.getSession(); if (session) window.initApp(session.user); }
checkSession();

window.logoutUser = async function() { await db.auth.signOut(); window.location.reload(); }
