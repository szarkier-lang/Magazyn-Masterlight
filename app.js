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
    'm.czyzewska@masterlight.pl': 'worker'
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
const imperialAngleMaster = { '1': '1', '2': '2', '4': '2', '3': '3', '5': '3' };
const imperialAngleSync = { '1': ['1'], '2': ['2','4'], '3': ['3','5'] };

const pxfAngleMaster = { '6': '6', '7': '7', '9': '7', '8': '8', '10': '8' };
const pxfAngleSync = { '6': ['6'], '7': ['7','9'], '8': ['8','10'] };

// --- FUNKCJE POMOCNICZE UI ---
function showLoading() { document.getElementById('loading-screen').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading-screen').classList.add('hidden'); }

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = type === 'error' ? 'error' : (type === 'warning' ? 'warning' : 'check_circle');
    toast.innerHTML = `<span class="material-symbols-outlined">${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('toast-fadeOut'); toast.addEventListener('animationend', () => toast.remove()); }, 3500);
}

function showModal(title, content) {
    document.getElementById('modal-title-old').textContent = title;
    document.getElementById('modal-content-old').innerHTML = content;
    document.getElementById('modal').style.display = 'block';
}
function closeModal() { document.getElementById('modal').style.display = 'none'; }
function escapeHTML(str) { return String(str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    if (currentUserEmail) { 
        inactivityTimer = setTimeout(async () => {
            showToast('Sesja wygasła z powodu braku aktywności (5 min).', 'warning');
            await db.auth.signOut();
            window.location.reload();
        }, INACTIVITY_TIME_MS);
    }
}
['click', 'mousemove', 'keypress', 'scroll', 'touchstart'].forEach(event => { document.addEventListener(event, resetInactivityTimer, true); });

function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('open');
    document.getElementById('mobile-overlay').classList.toggle('active');
}

function closeSidePanel() {
    const panel = document.getElementById('details-panel');
    if(panel) panel.classList.remove('open');
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    const clickedNav = Array.from(document.querySelectorAll('.nav-item')).find(item => item.getAttribute('onclick').includes(tabId));
    if (clickedNav) clickedNav.classList.add('active');
    
    closeSidePanel(); 
    
    if (window.innerWidth <= 768) {
        document.querySelector('.sidebar').classList.remove('open');
        document.getElementById('mobile-overlay').classList.remove('active');
    }
    if (tabId === 'tab-dashboard') {
        setTimeout(() => { 
            if (!map) initMap();
            if (map) map.invalidateSize(); 
            if(window.inventory && !isUpdatingMap) updateMapMarkers(window.inventory.shipments, window.inventory.adjustments);
        }, 150);
    }
    if (tabId === 'tab-adjustments') {
        setTimeout(() => { 
            if (!mapAdj) initAdjMap();
            if (mapAdj) mapAdj.invalidateSize(); 
            if(window.inventory) updateAdjMapMarkers(window.inventory.adjustments);
        }, 150);
    }
}

// --- GŁÓWNA KLASA SYSTEMU WMS ---
class CloudInventoryManager {
    constructor() { 
        this.products = []; this.shipments = []; this.history = []; this.adjustments = []; 
        this.serviceCases = []; 
        this.components = { ps_raw: 0, clips_normal: 0, clips_pass: 0, reflector_22: 0, reflector_37: 0, reflector_58: 0 };
        this.realtimeTimeout = null; this.isFirstLoad = true; 
    }
    
    async init() { 
        showLoading(); 
        this.patchDOMForPXFRaw(); // Automatyczna przebudowa HTML dla surowych PXF
        await this.fetchData(); 
        this.setupRealtime(); 
        this.bindForms(); 
        hideLoading(); 
        if (this.isFirstLoad && this.products.length > 0) { showToast(`Zalogowano pomyślnie.`, 'success'); this.isFirstLoad = false; } 
    }

    // Funkcja dynamicznie przebudowująca formularze i tabele bez edycji pliku HTML
    patchDOMForPXFRaw() {
        const pxfTh = document.querySelector('#products-pxf-table')?.parentElement?.querySelector('thead tr');
        if (pxfTh && !pxfTh.innerHTML.includes('Surowe')) {
            pxfTh.innerHTML = '<th>Kąt Oprawy</th><th>Gotowe 15W</th><th>Gotowe 20W</th><th>Surowe (W Montażu)</th><th>Serwis (Suma)</th><th>Łącznie Suma</th><th>Dostępność</th>';
        }

        const pxfIncForm = document.getElementById('incomingPxfForm');
        if (pxfIncForm && pxfIncForm.innerHTML.includes('p9')) {
            pxfIncForm.innerHTML = `
                <div class="form-group" style="margin-bottom: 1rem;"><label>Dostawca</label><input type="text" name="supplier" required placeholder="np. PXF Lighting"></div>
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                    <div class="form-group"><label>Surowe 22°</label><input type="number" name="p6" value="0" min="0"></div>
                    <div class="form-group"><label>Surowe 37°</label><input type="number" name="p7" value="0" min="0"></div>
                    <div class="form-group"><label>Surowe 58°</label><input type="number" name="p8" value="0" min="0"></div>
                </div>
                <button type="submit" class="btn-primary btn-pxf" style="width:100%;"><span class="material-symbols-outlined">add_circle</span> Przyjmij surowe oprawy PXF</button>
            `;
        }

        const prodContainer = document.getElementById('form-production-container');
        if (prodContainer && !document.getElementById('productionPxfForm')) {
            const pxfProdDiv = document.createElement('div');
            pxfProdDiv.className = 'section section-pxf';
            pxfProdDiv.style.marginTop = '1.5rem';
            pxfProdDiv.innerHTML = `
                <div class="section-header"><h2><span class="material-symbols-outlined">precision_manufacturing</span> Ustawienie Mocy (PXF)</h2></div>
                <div class="section-content">
                    <form id="productionPxfForm">
                        <div style="background-color: var(--pxf-light); border: 1px solid #D1D9E0; padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem;">
                            <h3 style="font-size: 0.9rem; color: #1E3A8A; text-transform:uppercase; letter-spacing:1px; margin-bottom: 1rem;">Skonfiguruj zasilacze w surowych oprawach PXF</h3>
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1.25rem;">
                                <div class="form-group"><label>22° -> 15W</label><input type="number" name="p6" value="0" min="0"></div>
                                <div class="form-group"><label>37° -> 15W</label><input type="number" name="p7" value="0" min="0"></div>
                                <div class="form-group"><label>58° -> 15W</label><input type="number" name="p8" value="0" min="0"></div>
                                <div class="form-group"><label>37° -> 20W</label><input type="number" name="p9" value="0" min="0"></div>
                                <div class="form-group"><label>58° -> 20W</label><input type="number" name="p10" value="0" min="0"></div>
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <button type="submit" class="btn-primary btn-pxf" style="padding: 0 2.5rem;"><span class="material-symbols-outlined">task_alt</span> Ustaw Moce</button>
                        </div>
                    </form>
                    <div style="margin-top: 1rem; background: #EFF6FF; padding: 1rem; border-radius: 12px; font-size: 0.8rem; color: #1E3A8A;">
                        <p>System zdejmuje "Surowe" oprawy PXF. Proces NIE ZUŻYWA osobnych zasilaczy z magazynu komponentów (zasilacz jest już w lampie).</p>
                    </div>
                </div>
            `;
            prodContainer.parentNode.insertBefore(pxfProdDiv, prodContainer.nextSibling);
        }
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

            if (prodsRes.error) throw prodsRes.error;
            this.products = prodsRes.data || [];
            this.components = compsRes.data || { ps_raw: 0, clips_normal: 0, clips_pass: 0, reflector_22:0, reflector_37:0, reflector_58:0 };
            this.shipments = shipsRes.data || [];
            this.adjustments = adjsRes.data || [];
            this.history = (histRes.data || []).map(x => ({ timestamp: new Date(x.created_at).toLocaleString('pl-PL'), action: x.action || 'Nieznana operacja', details: x.details || '' }));
            this.serviceCases = servRes.error ? [] : (servRes.data || []);
            
            const t = new Date().toISOString().split('T')[0];
            const upds = [];
            for (let sh of this.shipments) { 
                if (sh.status !== 'completed' && (sh.date || '') < t) { 
                    if (currentRole === 'admin' || currentRole === 'worker') { upds.push(db.from('shipments').update({ date: t }).eq('id', sh.id)); }
                    sh.date = t;
                } 
            }
            if (upds.length > 0) await Promise.all(upds);
            
            this.updateDashboard();
        } catch(e) { console.error("Błąd Bazy:", e); hideLoading(); }
    }

    setupRealtime() { db.channel('public:all').on('postgres_changes', { event: '*', schema: 'public' }, () => { clearTimeout(this.realtimeTimeout); this.realtimeTimeout = setTimeout(() => this.fetchData(), 500); }).subscribe(); }
    async addHistory(action, details) { const u = currentUserEmail.split('@')[0]; const d = `${details} (przez: ${u})`; this.history.unshift({ timestamp: new Date().toLocaleString('pl-PL'), action, details: d }); await db.from('history').insert([{ action, details: d }]); }
    async addServiceCase(actionType, productName, qty, desc) { await db.from('service_history').insert([{ action_type: actionType, product_name: productName, quantity: qty, description: desc }]); }
    
    getStatus(id) { const p = this.products.find(x => String(x.id) === String(id)); if (!p) return 'unknown'; const t = (parseInt(p.ready)||0) + (parseInt(p.assembly)||0) + (parseInt(p.service)||0); return t === 0 ? 'error' : (t >= 50 ? 'ok' : 'warning'); }
    
    async updateProduct(id, updates) {
        if (currentRole === 'viewer') return;
        const p = this.products.find(x => String(x.id) === String(id));
        if (p) { 
            Object.assign(p, updates); this.updateDashboard(); await db.from('products').update(updates).eq('id', id); 
            if (updates.assembly !== undefined) {
                let syncMap = parseInt(id) <= 5 ? imperialAngleSync : pxfAngleSync;
                const targets = syncMap[id] || [];
                for(let t of targets) {
                    if(t !== String(id)) { 
                        await db.from('products').update({ assembly: updates.assembly }).eq('id', t); 
                        const tp = this.products.find(x => String(x.id) === t); 
                        if(tp) tp.assembly = updates.assembly; 
                    }
                }
            }
            await this.addHistory('Edycja stanu ręczna', p.name); await this.fetchData(); 
        }
    }

    // --- IMPERIAL ---
    async addIncomingImperial(supplier, newProducts) {
        if (currentRole === 'viewer') return;
        let totalAdded = 0; const dbUpdates = [];
        for (const [masterId, qtyStr] of Object.entries(newProducts)) {
            let qty = parseInt(qtyStr);
            if (qty > 0) {
                const masterProduct = this.products.find(p => String(p.id) === String(masterId));
                if (masterProduct) {
                    const newAssembly = (parseInt(masterProduct.assembly) || 0) + qty; const idsToUpdate = imperialAngleSync[masterId] || [masterId];
                    idsToUpdate.forEach(targetId => { dbUpdates.push(db.from('products').update({ assembly: newAssembly }).eq('id', targetId)); const targetProduct = this.products.find(p => String(p.id) === String(targetId)); if(targetProduct) targetProduct.assembly = newAssembly; });
                    totalAdded += qty;
                }
            }
        }
        if (dbUpdates.length > 0) await Promise.all(dbUpdates);
        if (totalAdded > 0) { await this.addHistory('Dostawa z Huty (IMPERIAL)', `${supplier} | 22°:${newProducts[1]} | 37°:${newProducts[2]} | 58°:${newProducts[3]}`); await this.fetchData(); }
    }

    async registerProduction(prod) {
        if (currentRole === 'viewer') return;
        const tp = Object.values(prod).reduce((a,b) => a + parseInt(b||0), 0); if (tp === 0) return;
        const minC = Math.min(parseInt(this.components.ps_raw)||0, parseInt(this.components.clips_normal)||0, parseInt(this.components.clips_pass)||0);
        if (tp > minC) { showToast('Brak zasilaczy lub klapek na magazynie!', 'error'); return; }
        const req = {}; for(const [id, q] of Object.entries(prod)) { let qq = parseInt(q); if(qq > 0) { let mId = imperialAngleMaster[id] || id; req[mId] = (req[mId] || 0) + qq; } }
        for(const [mId, q] of Object.entries(req)) { const masterP = this.products.find(x => String(x.id) === String(mId)); let av = masterP ? (parseInt(masterP.assembly)||0) : 0; if(q > av) { showToast('Brak surowych obudów IMPERIAL na ten kąt!', 'error'); return; } }
        const upds = []; let tpReal = 0; const assemblyUpdates = {}; const readyUpdates = {};
        for (const [id, q] of Object.entries(prod)) {
            let qq = parseInt(q);
            if(qq > 0) { 
                const p = this.products.find(x => String(x.id) === String(id));
                if(p) { p.ready = (parseInt(p.ready) || 0) + qq; readyUpdates[p.id] = p.ready; let mId = imperialAngleMaster[id] || id; if (assemblyUpdates[mId] === undefined) { const masterP = this.products.find(x => String(x.id) === String(mId)); assemblyUpdates[mId] = masterP ? (parseInt(masterP.assembly) || 0) : 0; } assemblyUpdates[mId] -= qq; tpReal += qq; } 
            }
        }
        for (const [pid, newReady] of Object.entries(readyUpdates)) { upds.push(db.from('products').update({ ready: newReady }).eq('id', pid)); }
        for (const [mId, newAssembly] of Object.entries(assemblyUpdates)) { const targets = imperialAngleSync[mId] || [mId]; for (let targetId of targets) { upds.push(db.from('products').update({ assembly: newAssembly }).eq('id', targetId)); const p = this.products.find(x => String(x.id) === targetId); if (p) p.assembly = newAssembly; } }
        if(tpReal > 0) { 
            this.components.ps_raw -= tpReal; this.components.clips_normal -= tpReal; this.components.clips_pass -= tpReal; 
            upds.push(db.from('components').update({ ps_raw: this.components.ps_raw, clips_normal: this.components.clips_normal, clips_pass: this.components.clips_pass }).eq('id', 1)); 
            await Promise.all(upds); await this.addHistory('Raport z produkcji (IMPERIAL)', `Zmontowano sztuk: ${tpReal}`); showToast('Zmontowano IMPERIAL', 'success'); await this.fetchData();
        }
    }

    // --- PXF ---
    async addIncomingPxf(supplier, newProducts) {
        if (currentRole === 'viewer') return;
        let totalAdded = 0; const dbUpdates = [];
        for (const [masterId, qtyStr] of Object.entries(newProducts)) {
            let qty = parseInt(qtyStr);
            if (qty > 0) { 
                const masterProduct = this.products.find(p => String(p.id) === String(masterId));
                if (masterProduct) {
                    const newAssembly = (parseInt(masterProduct.assembly) || 0) + qty; 
                    const idsToUpdate = pxfAngleSync[masterId] || [masterId];
                    idsToUpdate.forEach(targetId => { 
                        dbUpdates.push(db.from('products').update({ assembly: newAssembly }).eq('id', targetId)); 
                        const targetProduct = this.products.find(p => String(p.id) === String(targetId)); 
                        if(targetProduct) targetProduct.assembly = newAssembly; 
                    });
                    totalAdded += qty;
                }
            }
        }
        if (dbUpdates.length > 0) await Promise.all(dbUpdates);
        if (totalAdded > 0) { await this.addHistory('Dostawa Surowych (PXF)', `Dostawca: ${supplier} | Wgrano łącznie: ${totalAdded} szt.`); await this.fetchData(); }
    }

    async registerProductionPxf(prod) {
        if (currentRole === 'viewer') return;
        const tp = Object.values(prod).reduce((a,b) => a + parseInt(b||0), 0); if (tp === 0) return;
        
        const req = {}; 
        for(const [id, q] of Object.entries(prod)) { let qq = parseInt(q); if(qq > 0) { let mId = pxfAngleMaster[id] || id; req[mId] = (req[mId] || 0) + qq; } }
        
        for(const [mId, q] of Object.entries(req)) { 
            const masterP = this.products.find(x => String(x.id) === String(mId)); 
            let av = masterP ? (parseInt(masterP.assembly)||0) : 0; 
            if(q > av) { showToast('Brak surowych obudów PXF na ten kąt!', 'error'); return; } 
        }
        
        const upds = []; let tpReal = 0; const assemblyUpdates = {}; const readyUpdates = {};
        for (const [id, q] of Object.entries(prod)) {
            let qq = parseInt(q);
            if(qq > 0) { 
                const p = this.products.find(x => String(x.id) === String(id));
                if(p) { 
                    p.ready = (parseInt(p.ready) || 0) + qq; 
                    readyUpdates[p.id] = p.ready; 
                    let mId = pxfAngleMaster[id] || id; 
                    if (assemblyUpdates[mId] === undefined) { 
                        const masterP = this.products.find(x => String(x.id) === String(mId)); 
                        assemblyUpdates[mId] = masterP ? (parseInt(masterP.assembly) || 0) : 0; 
                    } 
                    assemblyUpdates[mId] -= qq; tpReal += qq; 
                } 
            }
        }
        
        for (const [pid, newReady] of Object.entries(readyUpdates)) { upds.push(db.from('products').update({ ready: newReady }).eq('id', pid)); }
        for (const [mId, newAssembly] of Object.entries(assemblyUpdates)) { 
            const targets = pxfAngleSync[mId] || [mId]; 
            for (let targetId of targets) { 
                upds.push(db.from('products').update({ assembly: newAssembly }).eq('id', targetId)); 
                const p = this.products.find(x => String(x.id) === targetId); 
                if (p) p.assembly = newAssembly; 
            } 
        }
        
        if(tpReal > 0) { 
            await Promise.all(upds); 
            await this.addHistory('Ustawienie Mocy (PXF)', `Skonfigurowano sztuk: ${tpReal}`); 
            showToast('Skonfigurowano moce PXF', 'success'); 
            await this.fetchData();
        }
    }

    async swapPxfAngle(fromAngle, toAngle, power, qty) {
        if (currentRole === 'viewer') return;
        const getPxfId = (a, p) => { if (a === '22' && p === '15') return 6; if (a === '37' && p === '15') return 7; if (a === '58' && p === '15') return 8; if (a === '37' && p === '20') return 9; if (a === '58' && p === '20') return 10; return null; };
        const sourceId = getPxfId(fromAngle, power); const targetId = getPxfId(toAngle, power);
        if (!sourceId || !targetId) { showToast('Nieprawidłowa kombinacja.', 'error'); return; }
        const sourceP = this.products.find(p => p.id === sourceId); const targetP = this.products.find(p => p.id === targetId);
        if ((parseInt(sourceP.ready) || 0) < qty) { showToast(`Brak wystarczającej ilości lamp Gotowych PXF dla kąta ${fromAngle}°`, 'error'); return; }
        const targetReflectorField = `reflector_${toAngle}`; const sourceReflectorField = `reflector_${fromAngle}`;
        if ((parseInt(this.components[targetReflectorField]) || 0) < qty) { showToast(`Brakuje Ci odbłyśników ${toAngle}° w magazynie komponentów!`, 'error'); return; }
        sourceP.ready = (parseInt(sourceP.ready) || 0) - qty; targetP.ready = (parseInt(targetP.ready) || 0) + qty;
        this.components[targetReflectorField] = (parseInt(this.components[targetReflectorField]) || 0) - qty; this.components[sourceReflectorField] = (parseInt(this.components[sourceReflectorField]) || 0) + qty;
        const upds = [ db.from('products').update({ ready: sourceP.ready }).eq('id', sourceId), db.from('products').update({ ready: targetP.ready }).eq('id', targetId), db.from('components').update({ [targetReflectorField]: this.components[targetReflectorField], [sourceReflectorField]: this.components[sourceReflectorField] }).eq('id', 1) ];
        await Promise.all(upds); await this.addHistory('Przezbrojenie (PXF)', `Konwersja z ${fromAngle}° na ${toAngle}° (${power}W). Ilość: ${qty} szt.`); showToast('Kąty zostały zamienione!', 'success'); await this.fetchData();
    }

    // --- WYSYŁKI ---
    async addShipment(s) { 
        if (currentRole === 'viewer') return;
        const { error } = await db.from('shipments').insert([{ date: s.date, location: s.location, company: s.company, products: s.products, status: 'planned', is_confirmed: false, is_replacement: s.is_replacement, brand: s.brand }]); 
        if (error) { console.error("Błąd Supabase:", error); showToast('Błąd bazy danych (sprawdź konsolę F12).', 'error'); return; }
        await this.addHistory(s.is_replacement ? 'Utworzono Wysyłkę SERWISOWĄ' : 'Dodano zamówienie', `${s.location} [${s.brand.toUpperCase()}]`); 
        await this.fetchData(); 
    }

    async confirmShipment(id) { 
        if (currentRole === 'viewer') return;
        const s = this.shipments.find(x => String(x.id) === String(id)); 
        if (s) { s.is_confirmed = true; await db.from('shipments').update({ is_confirmed: true }).eq('id', id); await this.addHistory('Potwierdzenie daty wyjazdu', s.location); await this.fetchData(); } 
    }

    async deleteShipment(id) { 
        if (currentRole !== 'admin') return;
        this.shipments = this.shipments.filter(s => String(s.id) !== String(id)); 
        await db.from('shipments').delete().eq('id', id); await this.addHistory('Anulowanie zamówienia w systemie', `Skasowano`); await this.fetchData();
    }

    async updateShipmentInDB(id, data) { 
        if (currentRole === 'viewer') return;
        const s = this.shipments.find(x => String(x.id) === String(id)); 
        if (s) { 
            const { error } = await db.from('shipments').update(data).eq('id', id); 
            if (error) { console.error("Błąd edycji Supabase:", error); showToast('Błąd zapisu! Sprawdź konsolę (F12).', 'error'); return; }
            Object.assign(s, data); 
            await this.addHistory('Edycja szczegółów zamówienia', s.location); 
            await this.fetchData(); 
        } 
    }
    
    async completeShipment(id) {
        if (currentRole === 'viewer') return;
        const s = this.shipments.find(x => String(x.id) === String(id)); if (!s) return;
        const mis = {}, upds = [];
        for (const [pId, qty] of Object.entries(s.products || {})) {
            let q = parseInt(qty);
            if(q > 0) { const p = this.products.find(x => String(x.id) === String(pId)); if(p) { let ded = Math.min(q, parseInt(p.ready)||0); p.ready = (parseInt(p.ready)||0) - ded; if(q - ded > 0) mis[pId] = q - ded; if(ded > 0) upds.push(db.from('products').update({ ready: p.ready }).eq('id', p.id)); } }
        }
        s.status = Object.keys(mis).length > 0 ? 'partial' : 'completed'; s.partial_missing = Object.keys(mis).length > 0 ? mis : null; s.is_confirmed = true; 
        if(upds.length > 0) await Promise.all(upds); await db.from('shipments').update({ status: s.status, partial_missing: s.partial_missing, is_confirmed: true }).eq('id', id);
        await this.addHistory(Object.keys(mis).length > 0 ? `Wydano (niepełna przesyłka)` : `Wydano pełny komplet`, s.location); await this.fetchData();
    }

    async completeRemainingShipment(id) {
        if (currentRole === 'viewer') return;
        const s = this.shipments.find(x => String(x.id) === String(id)); if (!s || s.status !== 'partial' || !s.partial_missing) return;
        const mis = s.partial_missing, smis = {}, upds = [];
        for (const [pId, needStr] of Object.entries(mis)) {
            let need = parseInt(needStr); const p = this.products.find(x => String(x.id) === String(pId)); 
            if(p) { let ded = Math.min(need, parseInt(p.ready)||0); p.ready = (parseInt(p.ready)||0) - ded; if(need - ded > 0) smis[pId] = need - ded; if(ded > 0) upds.push(db.from('products').update({ ready: p.ready }).eq('id', p.id)); }
        }
        s.status = Object.keys(smis).length > 0 ? 'partial' : 'completed'; s.partial_missing = Object.keys(smis).length > 0 ? smis : null; 
        if(upds.length > 0) await Promise.all(upds); await db.from('shipments').update({ status: s.status, partial_missing: s.partial_missing }).eq('id', id); 
        await this.addHistory(Object.keys(smis).length > 0 ? `Wydano część braków` : `Wydano zaległe braki (komplet)`, s.location); await this.fetchData();
    }

    // --- REGULACJE, SERWIS I KOMPONENTY ---
    async addAdjustment(date, location) { if (currentRole === 'viewer') return; await db.from('adjustments').insert([{ date, location }]); await this.addHistory('Planowanie regulacji', `${location} - ${date}`); await this.fetchData(); }
    async updateAdjustmentDate(id, newDate) { if (currentRole === 'viewer') return; const a = this.adjustments.find(x => String(x.id) === String(id)); if (a) { a.date = newDate; await db.from('adjustments').update({ date: newDate }).eq('id', id); await this.addHistory('Zmiana terminu serwisu', `${a.location} na ${newDate}`); await this.fetchData(); } }
    async deleteAdjustment(id) { if (currentRole !== 'admin') return; this.adjustments = this.adjustments.filter(a => String(a.id) !== String(id)); await db.from('adjustments').delete().eq('id', id); await this.addHistory('Usunięcie regulacji z kalendarza', `Rekord skasowany`); await this.fetchData(); }

    async processDamagedReturn(productId, qty, salvagedPsQty, desc) {
        const p = this.products.find(x => String(x.id) === String(productId)); if (!p) return; p.damaged = (parseInt(p.damaged) || 0) + qty;
        const updates = [ db.from('products').update({ damaged: p.damaged }).eq('id', productId) ]; let histMsg = `Przyjęto uszkodzone szt: ${qty}.`;
        if(salvagedPsQty > 0) { this.components.ps_raw = (parseInt(this.components.ps_raw)||0) + salvagedPsQty; updates.push(db.from('components').update({ps_raw: this.components.ps_raw}).eq('id', 1)); histMsg += ` Odzyskano zasilaczy: ${salvagedPsQty}.`; }
        await Promise.all(updates); await this.addHistory(`Zwrot z RMA [${p.name}]`, histMsg); await this.addServiceCase('Przyjęcie z RMA', p.name, qty, desc); await this.fetchData();
    }

    async sendToService(productId, qty, desc) {
        const p = this.products.find(x => String(x.id) === String(productId)); if (!p || (parseInt(p.damaged)||0) < qty) return;
        p.damaged = parseInt(p.damaged) - qty; p.service = (parseInt(p.service)||0) + qty;
        await db.from('products').update({ damaged: p.damaged, service: p.service }).eq('id', productId); await this.addHistory(`Wydano na Serwis`, `Model: ${p.name}, Ilość: ${qty}`); await this.addServiceCase('Wysłano do Serwisu', p.name, qty, desc); await this.fetchData();
    }

    async receiveFromService(productId, qty, newPsUsed, desc) {
        const p = this.products.find(x => String(x.id) === String(productId)); if (!p || (parseInt(p.service)||0) < qty) return;
        p.service = parseInt(p.service) - qty; p.ready = (parseInt(p.ready)||0) + qty;
        const updates = [ db.from('products').update({ service: p.service, ready: p.ready }).eq('id', productId) ]; let histMsg = `Naprawiono szt: ${qty}.`;
        if(newPsUsed > 0) { this.components.ps_raw = (parseInt(this.components.ps_raw)||0) - newPsUsed; updates.push(db.from('components').update({ps_raw: this.components.ps_raw}).eq('id', 1)); histMsg += ` Zużyto NOWYCH zasilaczy: ${newPsUsed}.`; }
        await Promise.all(updates); await this.addHistory(`Zakończono naprawę [${p.name}]`, histMsg); await this.addServiceCase('Odbiór z Serwisu', p.name, qty, desc); await this.fetchData();
    }

    async addComponentsShipment(sup, nc) { 
        if (currentRole === 'viewer') return;
        const u = { ps_raw: (parseInt(this.components.ps_raw)||0) + (parseInt(nc.ps_raw)||0), clips_normal: (parseInt(this.components.clips_normal)||0) + (parseInt(nc.clips_normal)||0), clips_pass: (parseInt(this.components.clips_pass)||0) + (parseInt(nc.clips_pass)||0), reflector_22: (parseInt(this.components.reflector_22)||0) + (parseInt(nc.reflector_22)||0), reflector_37: (parseInt(this.components.reflector_37)||0) + (parseInt(nc.reflector_37)||0), reflector_58: (parseInt(this.components.reflector_58)||0) + (parseInt(nc.reflector_58)||0) };
        await db.from('components').update(u).eq('id', 1); await this.addHistory('Dostawa komponentów', sup); await this.fetchData();
    }

    async updateComponent(f, v) { 
        if (currentRole === 'viewer') return; await db.from('components').update({ [f]: v }).eq('id', 1); await this.addHistory('Korekta ręczna komponentów', `Zaktualizowano stan bazy.`); await this.fetchData();
    }

    // --- PREDYKCJA (Burn-down V2.1 - Imperial i PXF) ---
    renderPredictions() {
        const container = document.getElementById('prediction-cards-container');
        if (!container) return;

        let readyMap = {};
        let assemblyMap = { '1': 0, '2': 0, '3': 0, '6': 0, '7': 0, '8': 0 };

        this.products.forEach(p => {
            readyMap[p.id] = parseInt(p.ready) || 0;
            if (p.id == 1) assemblyMap['1'] = parseInt(p.assembly) || 0;
            if (p.id == 2) assemblyMap['2'] = parseInt(p.assembly) || 0;
            if (p.id == 3) assemblyMap['3'] = parseInt(p.assembly) || 0;
            if (p.id == 6) assemblyMap['6'] = parseInt(p.assembly) || 0;
            if (p.id == 7) assemblyMap['7'] = parseInt(p.assembly) || 0;
            if (p.id == 8) assemblyMap['8'] = parseInt(p.assembly) || 0;
        });

        let ps = parseInt(this.components.ps_raw) || 0;
        let clipsN = parseInt(this.components.clips_normal) || 0;
        let clipsP = parseInt(this.components.clips_pass) || 0;

        const upcoming = this.shipments
            .filter(s => s.status !== 'completed')
            .sort((a, b) => {
                let da = new Date(a.date).getTime() || 0;
                let db = new Date(b.date).getTime() || 0;
                return da - db;
            });

        let shortages = { 'ps': null, 'cn': null, 'cp': null };
        let fixtureShortages = {}; 

        const imperialMasterName = { '1': 'Surowe Imperial 22°', '2': 'Surowe Imperial 37°', '3': 'Surowe Imperial 58°' };

        for (let s of upcoming) {
            let req = s.status === 'partial' ? s.partial_missing : s.products;
            if (!req) continue;

            for (const [pidStr, qtyStr] of Object.entries(req)) {
                let pid = String(pidStr);
                let needed = parseInt(qtyStr) || 0;
                if (needed <= 0) continue;

                let availableReady = readyMap[pid] || 0;

                if (availableReady >= needed) {
                    readyMap[pid] -= needed;
                } else {
                    let missingReady = needed - availableReady;
                    readyMap[pid] = 0;

                    if (['1','2','3','4','5'].includes(pid)) {
                        let masterId = imperialAngleMaster[pid];
                        
                        ps -= missingReady;
                        clipsN -= missingReady;
                        clipsP -= missingReady;

                        if (ps < 0 && !shortages['ps']) shortages['ps'] = s.date;
                        if (clipsN < 0 && !shortages['cn']) shortages['cn'] = s.date;
                        if (clipsP < 0 && !shortages['cp']) shortages['cp'] = s.date;

                        assemblyMap[masterId] -= missingReady;
                        if (assemblyMap[masterId] < 0) {
                            let name = imperialMasterName[masterId];
                            if (!fixtureShortages[name]) fixtureShortages[name] = s.date;
                        }
                    } else if (['6','7','8','9','10'].includes(pid)) {
                        let masterId = pxfAngleMaster[pid];
                        assemblyMap[masterId] -= missingReady;
                        if (assemblyMap[masterId] < 0) {
                            let pObj = this.products.find(x => String(x.id) === masterId);
                            let name = pObj ? `Surowe PXF ${pObj.name.split(' ')[1]}` : `PXF ID:${pid}`;
                            if (!fixtureShortages[name]) fixtureShortages[name] = s.date;
                        }
                    }
                }
            }
        }

        const createCard = (title, currentVal, shortageDate, isWarningCard = false) => {
            const isCritical = shortageDate !== null;
            let dateStr = 'Zapas OK';
            if (isCritical) { let d = new Date(shortageDate); dateStr = isNaN(d.getTime()) ? shortageDate : d.toLocaleDateString('pl-PL'); }
            const statusClass = isCritical ? 'predictive critical' : 'predictive';
            const labelStr = isCritical ? `Brak na: ${dateStr}` : dateStr;
            const icon = isCritical ? 'warning' : 'check_circle';
            
            let valHtml = currentVal;
            if (typeof currentVal === 'number') { valHtml = `${currentVal} <span style="font-size:1rem; color:var(--text-secondary);">szt</span>`; }

            return `
                <div class="stat-card ${statusClass}" style="${isWarningCard ? 'background-color: #FEF2F2; border-color: #FECACA;' : ''}">
                    <h3 style="${isWarningCard ? 'color: #991B1B;' : ''}">${title}</h3>
                    <div class="value" style="font-size: 1.8rem; ${isWarningCard ? 'color: #991B1B;' : ''}">${valHtml}</div>
                    <span class="prediction-label"><span class="material-symbols-outlined" style="font-size:1.1em; margin-right:4px; vertical-align:-0.2em;">${icon}</span>${labelStr}</span>
                </div>
            `;
        };

        let html = '';
        html += createCard('Zasilacze LED', this.components.ps_raw || 0, shortages['ps']);
        html += createCard('Klapki Zwykłe', this.components.clips_normal || 0, shortages['cn']);

        if (Object.keys(fixtureShortages).length > 0) {
            for (const [name, date] of Object.entries(fixtureShortages)) { html += createCard(`BRAKUJE OPRAW`, name, date, true); }
        } else {
            html += createCard('Zapas Opraw', 'Dostępne', null);
        }

        container.innerHTML = html;
    }

    // --- RENDEROWANIE WIDOKÓW TABEL I INTERFEJSU ---
    getTotals() {
        const sImp = new Set(); let tAImp = 0; 
        const sPxf = new Set(); let tAPxf = 0;
        this.products.forEach(p => { 
            if(p.id <= 5) { let mId = imperialAngleMaster[p.id] || p.id; if (!sImp.has(mId)) { tAImp += parseInt(p.assembly)||0; sImp.add(mId); } }
            if(p.id >= 6 && p.id <= 10) { let mId = pxfAngleMaster[p.id] || p.id; if (!sPxf.has(mId)) { tAPxf += parseInt(p.assembly)||0; sPxf.add(mId); } }
        });
        const totalAssemblyAll = tAImp + tAPxf;
        return { 
            totalReady: this.products.reduce((sum, p) => sum + (parseInt(p.ready)||0), 0), 
            totalAssembly: totalAssemblyAll, 
            totalService: this.products.reduce((sum, p) => sum + (parseInt(p.service)||0) + (parseInt(p.damaged)||0), 0), 
            totalAll: this.products.reduce((sum, p) => sum + (parseInt(p.ready)||0), 0) + totalAssemblyAll + this.products.reduce((sum, p) => sum + (parseInt(p.service)||0) + (parseInt(p.damaged)||0), 0) 
        };
    }

    updateDashboard() {
        try {
            if(!this.products || this.products.length === 0) return;
            const t = this.getTotals();
            const elTotal = document.querySelector('[data-stat="total"]'); if(elTotal) elTotal.textContent = t.totalAll; 
            const elReady = document.querySelector('[data-stat="ready"]'); if(elReady) elReady.textContent = t.totalReady;
            const elShipments = document.querySelector('[data-stat="shipments"]'); if(elShipments) elShipments.textContent = this.shipments.filter(s => s.status!=='completed'&&s.is_confirmed).length;
            const elService = document.querySelector('[data-stat="service"]'); if(elService) elService.textContent = t.totalService;
            
            const alertsContainer = document.getElementById('dashboard-alerts'); if(alertsContainer) alertsContainer.innerHTML = '';
            const c = this.components; let lc = [];
            if(c) { if((parseInt(c.ps_raw)||0)<50) lc.push('Zasilacze'); if((parseInt(c.clips_normal)||0)<50) lc.push('Klapki Zwykłe'); if((parseInt(c.clips_pass)||0)<50) lc.push('Klapki Przelotowe'); }
            if(lc.length>0 && alertsContainer) { alertsContainer.innerHTML = `<div class="alert-banner critical"><span class="material-symbols-outlined">warning_amber</span><div><strong>Krytyczny stan!</strong> Pilnie domów: ${lc.join(', ')}.</div></div>`; }

            this.renderPredictions();

            const rMap = getShipmentsReadinessMap();
            renderCalendar(rMap);
            if(document.getElementById('tab-dashboard').classList.contains('active')) { updateMapMarkers(this.shipments, this.adjustments); }

            const itb = document.getElementById('dashboard-recent-incoming');
            if (itb && this.history) {
                itb.innerHTML = '';
                const rI = this.history.filter(h => h && h.action && (h.action.includes('Dostawa opraw') || h.action.includes('Dostawa obudów') || h.action.includes('Dostawa z Huty') || h.action.includes('Dostawa Gotowych') || h.action.includes('Dostawa Surowych'))).slice(0, 2);
                if(rI.length === 0) { itb.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 2rem !important; border:none; color: gray;">Brak historii dostaw.</td></tr>'; } 
                else {
                    rI.forEach(e => { 
                        if(!e||!e.details) return; 
                        if(e.action.includes('PXF')) {
                            itb.innerHTML += `<tr><td><strong>${(e.timestamp||'').split(',')[0]}</strong></td><td><strong style="color:#1E3A8A;">PXF</strong></td><td colspan="3">${escapeHTML(e.details.split('|')[0])}</td><td><strong style="color:var(--success-status);">${e.details.match(/Wgrano.*?:\s*(\d+)/)?.[1] || 0}</strong> szt</td></tr>`;
                            return;
                        }
                        let s="-", p1="?", p2="?", p3="?", tv=0, cd=(e.details||"").replace(/\(przez:.*?\)/,'').trim();
                        if(cd.includes('|')) { let ps=cd.split('|').map(x=>x.trim()); s=ps[0]; const pq=(str)=>{ let m=(str||"").match(/:(\d+)/); return m ? parseInt(m[1]) : 0; }; p1=pq(ps[1]); p2=pq(ps[2]); p3=pq(ps[3]); tv = p1+p2+p3; } 
                        else { let m=cd.match(/(.*?)\s*\(\+(\d+)\s*szt\.\)/); if(m) { s=m[1].trim(); tv=parseInt(m[2]); } else { s=cd; } }
                        itb.innerHTML += `<tr><td><strong>${(e.timestamp||'').split(',')[0]}</strong></td><td><strong style="color:var(--primary-dark);">IMPERIAL</strong><br>${escapeHTML(s)}</td><td>${p1!=='?'?`<b>${p1}</b>`:p1}</td><td>${p2!=='?'?`<b>${p2}</b>`:p2}</td><td>${p3!=='?'?`<b>${p3}</b>`:p3}</td><td><strong style="color:var(--success-status);">${tv}</strong> szt</td></tr>`;
                    });
                }
            }

            updateInventoryTable();
            updateShipmentsTables(rMap); 
            updateAdjustmentsTable(); 
            if(currentRole !== 'worker') updateHistoryTable(); 
            updateServiceCasesTable();
            updateComponentsDisplay();

        } catch (err) { console.error("Błąd rysowania interfejsu:", err); }
    }

    // --- BINDOWANIE FORMULARZY ---
    bindForms() {
        const bind = (id, handler) => { const f = document.getElementById(id); if(f) f.addEventListener('submit', handler); };
        
        bind('incomingImperialForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Zapisywanie...'; btn.disabled = true;
            const fd = new FormData(e.target); await this.addIncomingImperial(fd.get('supplier'), { 1:parseInt(fd.get('p1'))||0, 2:parseInt(fd.get('p2'))||0, 3:parseInt(fd.get('p3'))||0 }); 
            e.target.reset(); btn.innerHTML = txt; btn.disabled = false; showToast('Przyjęto obudowy Imperial', 'success'); 
        });

        // Formularz PXF teraz przyjmuje surowe!
        bind('incomingPxfForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Zapisywanie...'; btn.disabled = true;
            const fd = new FormData(e.target); await this.addIncomingPxf(fd.get('supplier'), { 6:parseInt(fd.get('p6'))||0, 7:parseInt(fd.get('p7'))||0, 8:parseInt(fd.get('p8'))||0 }); 
            e.target.reset(); btn.innerHTML = txt; btn.disabled = false; showToast('Przyjęto surowe lampy PXF', 'success'); 
        });

        bind('productionForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Przetwarzanie...'; btn.disabled = true;
            const fd = new FormData(e.target); await this.registerProduction({ 1:parseInt(fd.get('p1'))||0, 2:parseInt(fd.get('p2'))||0, 3:parseInt(fd.get('p3'))||0, 4:parseInt(fd.get('p4'))||0, 5:parseInt(fd.get('p5'))||0 }); 
            e.target.reset(); btn.innerHTML = txt; btn.disabled = false; 
        });

        // Nowy formularz produkcji PXF
        bind('productionPxfForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Przetwarzanie...'; btn.disabled = true;
            const fd = new FormData(e.target); await this.registerProductionPxf({ 6:parseInt(fd.get('p6'))||0, 7:parseInt(fd.get('p7'))||0, 8:parseInt(fd.get('p8'))||0, 9:parseInt(fd.get('p9'))||0, 10:parseInt(fd.get('p10'))||0 }); 
            e.target.reset(); btn.innerHTML = txt; btn.disabled = false; 
        });

        bind('pxfSwapForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Konwersja...'; btn.disabled = true;
            const fd = new FormData(e.target); showLoading(); await this.swapPxfAngle(fd.get('angleFrom'), fd.get('angleTo'), fd.get('swapPower'), parseInt(fd.get('swapQty'))||0); 
            e.target.reset(); btn.innerHTML = txt; btn.disabled = false; hideLoading();
        });

        bind('shipmentForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return; 
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Przetwarzanie...'; btn.disabled = true; 
            const fd = new FormData(e.target); const brand = document.getElementById('form-brand').value;
            let prods = brand === 'imperial' ? { 1:parseInt(fd.get('p_22_15'))||0, 2:parseInt(fd.get('p_37_15'))||0, 3:parseInt(fd.get('p_58_15'))||0, 4:parseInt(fd.get('p_37_20'))||0, 5:parseInt(fd.get('p_58_20'))||0 } : { 6:parseInt(fd.get('p_22_15'))||0, 7:parseInt(fd.get('p_37_15'))||0, 8:parseInt(fd.get('p_58_15'))||0, 9:parseInt(fd.get('p_37_20'))||0, 10:parseInt(fd.get('p_58_20'))||0 };
            let loc = fd.get('ship_city').trim() + (fd.get('ship_street').trim() ? `, ${fd.get('ship_street').trim()}` : '') + (fd.get('ship_target').trim() ? ` (${fd.get('ship_target').trim()})` : '');
            showLoading(); await this.addShipment({ date: fd.get('date'), location: loc, company: fd.get('company'), products: prods, is_replacement: document.getElementById('form-is-replacement').checked, brand: brand }); 
            hideLoading(); e.target.reset(); btn.innerHTML = txt; btn.disabled = false; showToast('Dodano zamówienie', 'success');
        });

        bind('componentsIncomingForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Zapisywanie...'; btn.disabled = true;
            const fd = new FormData(e.target); showLoading(); 
            await this.addComponentsShipment(fd.get('supplier'), { ps_raw:parseInt(fd.get('ps_raw'))||0, clips_normal:parseInt(fd.get('clips_normal'))||0, clips_pass:parseInt(fd.get('clips_pass'))||0, reflector_22:parseInt(fd.get('r22'))||0, reflector_37:parseInt(fd.get('r37'))||0, reflector_58:parseInt(fd.get('r58'))||0 }); 
            hideLoading(); e.target.reset(); btn.innerHTML = txt; btn.disabled = false; showToast('Zapisano komponenty.', 'success'); 
        });

        bind('adjustmentForm', async (e) => { 
            e.preventDefault(); if (currentRole === 'viewer') return;
            const btn = e.target.querySelector('button[type="submit"]'); const txt = btn.innerHTML; btn.innerHTML = 'Zapisywanie...'; btn.disabled = true; 
            const fd = new FormData(e.target); let loc = fd.get('adj_city').trim() + (fd.get('adj_street').trim() ? `, ${fd.get('adj_street').trim()}` : '') + (fd.get('adj_target').trim() ? ` (${fd.get('adj_target').trim()})` : ''); 
            showLoading(); await this.addAdjustment(fd.get('adj_date'), loc); hideLoading(); 
            e.target.reset(); btn.innerHTML = txt; btn.disabled = false; showToast('Zapisano wyjazd', 'success'); 
        });
    }
}

// --- LOGOWANIE SUPABASE ---
const loginForm = document.getElementById('login-form');
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorElement = document.getElementById('login-error');
        const submitBtn = document.getElementById('login-submit-btn');
        errorElement.style.display = 'none'; submitBtn.disabled = true; submitBtn.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">autorenew</span> Autoryzacja...';
        
        const { data, error } = await db.auth.signInWithPassword({ email: document.getElementById('login-email').value, password: document.getElementById('login-password').value });
        if (error) { errorElement.textContent = 'Błąd autoryzacji. Sprawdź e-mail i hasło.'; errorElement.style.display = 'block'; submitBtn.disabled = false; submitBtn.innerHTML = '<span class="material-symbols-outlined">login</span> Zaloguj bezpiecznie'; } 
        else { initApp(data.user); }
    });
}

async function checkSession() { const { data: { session } } = await db.auth.getSession(); if (session) initApp(session.user); }

function initApp(user) { 
    currentUserEmail = user.email; currentRole = ROLES[user.email] || 'viewer'; 
    document.getElementById('logged-email').textContent = currentUserEmail; document.getElementById('footer-user').textContent = currentUserEmail;
    let roleText = currentRole === 'admin' ? 'Kierownik (Admin)' : (currentRole === 'worker' ? 'Pracownik (Worker)' : 'Obserwator (Viewer)');
    document.getElementById('logged-role').textContent = roleText;
    
    document.getElementById('auth-screen').classList.add('hidden'); document.getElementById('app-container').classList.remove('hidden'); document.getElementById('app-container').style.display = 'flex';
    resetInactivityTimer(); applyPermissions();
    window.inventory = new CloudInventoryManager(); window.inventory.init(); 
}

function applyPermissions() {
    if (currentRole === 'viewer') {
        ['form-shipment-container', 'form-incoming-imperial-container', 'form-incoming-pxf-container', 'form-components-container', 'form-production-container', 'form-adjustments-container', 'nav-history', 'nav-reports'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
        document.querySelectorAll('.editable').forEach(el => el.classList.remove('editable')); document.querySelectorAll('.admin-only-col').forEach(el => el.style.display = 'none');
    }
    if (currentRole === 'worker') { ['nav-history'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }); }
}

async function logoutUser() { clearTimeout(inactivityTimer); showLoading(); await db.auth.signOut(); window.location.reload(); }
checkSession();

// --- ZEWNĘTRZNE FUNKCJE TABEL ---
function getShipmentsReadinessMap() {
    const m = {}; if (!window.inventory || !window.inventory.products) return m;
    let vR = {}, vA = {}; 
    window.inventory.products.forEach(p => { 
        vR[String(p.id)] = parseInt(p.ready)||0; 
        if (p.id <= 5) { 
            let mId = imperialAngleMaster[p.id] || p.id; 
            if(vA[mId] === undefined) { const mP = window.inventory.products.find(x=>String(x.id)===String(mId)); vA[mId] = mP ? (parseInt(mP.assembly)||0) : 0; } 
        } else {
            let mId = pxfAngleMaster[p.id] || p.id; 
            if(vA[mId] === undefined) { const mP = window.inventory.products.find(x=>String(x.id)===String(mId)); vA[mId] = mP ? (parseInt(mP.assembly)||0) : 0; }
        }
    });
    let pend = (window.inventory.shipments || []).filter(s => s.status !== 'completed').sort((a,b)=>{ const ac=a.is_confirmed===true||a.is_confirmed==='true', bc=b.is_confirmed===true||b.is_confirmed==='true'; if(ac&&!bc) return -1; if(!ac&&bc) return 1; return(a.date||'').localeCompare(b.date||''); });
    pend.forEach(s => {
        let ok = true; let rq = s.status === 'partial' ? s.partial_missing : s.products;
        if(rq) { 
            for(const [pid, q] of Object.entries(rq)) { 
                let n = parseInt(q)||0; 
                if(n>0) { 
                    const p = window.inventory.products.find(x=>String(x.id)===String(pid)); 
                    if(!p) { ok=false; continue; } 
                    if(vR[pid]>=n) { vR[pid]-=n; n=0; } else { n-=vR[pid]; vR[pid]=0; } 
                    if(n>0 && p.id <= 5) { 
                        let mId = imperialAngleMaster[pid] || pid; 
                        if(vA[mId]>=n) { vA[mId]-=n; } else { vA[mId]-=n; ok=false; } 
                    } else if (n>0 && p.id > 5) { 
                        let mId = pxfAngleMaster[pid] || pid;
                        if(vA[mId]>=n) { vA[mId]-=n; } else { vA[mId]-=n; ok=false; } 
                    } 
                } 
            } 
        } 
        m[s.id] = ok;
    }); return m;
}

function updateShipmentsTables(readinessMap) {
    const tbodyUnconf = document.getElementById('shipments-unconfirmed-table'); const tbodyConf = document.getElementById('shipments-confirmed-table'); const tbodyComp = document.getElementById('shipments-completed-table');
    if(!tbodyUnconf || !tbodyConf || !tbodyComp) return;
    tbodyUnconf.innerHTML = ''; tbodyConf.innerHTML = ''; tbodyComp.innerHTML = '';
    let confCount = 0; const sortedShipments = [...window.inventory.shipments].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    sortedShipments.forEach(s => {
        if (s.status === 'completed') { tbodyComp.innerHTML += renderShipmentRow(s, readinessMap, false); } 
        else if (s.is_confirmed) { tbodyConf.innerHTML += renderShipmentRow(s, readinessMap, true); confCount++; } 
        else { tbodyUnconf.innerHTML += renderShipmentRow(s, readinessMap, true); }
    });
    const c = document.getElementById('shipments-count'); if(c) c.textContent = confCount + ' rekordów';
}

function renderShipmentRow(s, readinessMap, showActions = true) {
    let total = s.products ? Object.values(s.products).reduce((a, b) => parseInt(a) + parseInt(b), 0) : 0;
    let statusBadge = s.status === 'completed' ? '<span class="status-badge status-ok">Zrealizowana</span>' : (s.status === 'partial' ? '<span class="status-badge status-warning">Niepełna</span>' : (s.is_confirmed ? '<span class="status-badge status-neutral">Potwierdzona</span>' : '<span class="status-badge status-warning">Oczekująca</span>'));
    let readinessBadge = s.status === 'completed' ? '<span style="color: var(--text-light); font-size: 0.85em;">-</span>' : (readinessMap && readinessMap[s.id] ? '<span class="status-badge status-ok">Komplet</span>' : '<span class="status-badge status-error">Braki</span>');
    let typeBadge = s.is_replacement ? `<span class="status-badge" style="background:#FEE2E2; color:#B91C1C; border:1px solid #FECACA;">Wymiana</span>` : `<span class="status-badge status-neutral">Standard</span>`;
    let brandBadge = s.brand === 'pxf' ? `<strong style="color:#1E3A8A;">PXF</strong>` : `<strong style="color:var(--primary-dark);">IMPERIAL</strong>`;

    let actionButtons = '<div class="action-cell-flex">';
    if (currentRole !== 'viewer' && showActions) {
        actionButtons += `<button class="btn-small btn-secondary" onclick="openShipmentDetails('${s.id}')" title="Edytuj dane"><span class="material-symbols-outlined" style="margin:0;">edit</span></button>`;
        if (currentRole === 'admin') actionButtons += `<button class="btn-small btn-secondary" onclick="deleteShipment('${s.id}')" title="Usuń trwale"><span class="material-symbols-outlined" style="color:var(--accent-red); margin:0;">delete</span></button>`;
        if (s.status === 'planned' && !s.is_confirmed) actionButtons = `<button class="btn-small btn-primary" onclick="confirmShipmentDateUI('${s.id}')">Zatwierdź</button>` + actionButtons;
        else if (s.status === 'planned' && s.is_confirmed) actionButtons = `<button class="btn-small btn-primary" onclick="completeShipmentUI('${s.id}')">Wydaj Kurierowi</button>` + actionButtons;
        else if (s.status === 'partial') actionButtons = `<button class="btn-small btn-primary" onclick="completeRemainingShipmentUI('${s.id}')">Wydaj braki</button>` + actionButtons;
    }
    if (s.status === 'partial' && showActions) actionButtons += `<button class="btn-small btn-secondary" onclick="showMissingItems('${s.id}')" title="Pokaż listę braków"><span class="material-symbols-outlined">list_alt</span> Braki</button>`;
    actionButtons += '</div>';

    let dateLabel = s.status === 'completed' ? 'Data Wysłania' : (s.is_confirmed ? 'Data Potw.' : 'Data Wstępna');

    return `<tr class="${s.status === 'completed' ? 'row-completed' : ''}">
        <td data-label="${dateLabel}"><strong>${escapeHTML(s.date || '-')}</strong></td>
        <td data-label="Pula">${brandBadge}</td><td data-label="Cel">${escapeHTML(s.location)}</td><td data-label="Typ">${typeBadge}</td><td data-label="Sztuk"><strong>${total}</strong></td>
        <td data-label="Kąty"><button class="btn-small btn-secondary" onclick="showAnglesDemand('${s.id}')" style="margin:0;">Zestawienie</button></td>${s.status !== 'completed' ? `<td data-label="Magazyn">${readinessBadge}</td>` : ''}<td data-label="Status">${statusBadge}</td>
        ${showActions ? `<td data-label="Akcja" class="${currentRole === 'viewer' ? 'admin-only-col' : ''}">${actionButtons}</td>` : ''}
    </tr>`;
}

function updateInventoryTable() {
    const tbImp = document.getElementById('products-imperial-table'); const tbPxf = document.getElementById('products-pxf-table'); const tbSrv = document.getElementById('service-table');
    if(!tbImp || !tbPxf || !tbSrv) return;
    tbImp.innerHTML = ''; tbPxf.innerHTML = ''; tbSrv.innerHTML = ''; 
    const isViewer = currentRole === 'viewer'; const getP = (id) => window.inventory.products.find(x => String(x.id) === String(id)) || {};

    [{ name: 'IMPERIAL 22°', id15: 1, id20: null, idAssm: 1 }, { name: 'IMPERIAL 37°', id15: 2, id20: 4, idAssm: 2 }, { name: 'IMPERIAL 58°', id15: 3, id20: 5, idAssm: 3 }].forEach(a => {
        const p15 = getP(a.id15); const p20 = a.id20 ? getP(a.id20) : null; const pAssm = getP(a.idAssm);
        const r15 = parseInt(p15.ready) || 0; const r20 = p20 ? (parseInt(p20.ready) || 0) : 0; const assm = parseInt(pAssm.assembly) || 0;
        const s15 = (parseInt(p15.service)||0) + (parseInt(p15.damaged)||0); const s20 = p20 ? ((parseInt(p20.service)||0) + (parseInt(p20.damaged)||0)) : 0;
        const totSer = s15 + s20; const total = r15 + r20 + assm + totSer;
        const c15 = isViewer ? `<strong>${r15}</strong>` : `<td data-label="Gotowe 15W" onclick="editCell(this, 'ready', '${a.id15}')" class="editable"><strong>${r15}</strong></td>`;
        const c20 = a.id20 ? (isViewer ? `<strong>${r20}</strong>` : `<td data-label="Gotowe 20W" onclick="editCell(this, 'ready', '${a.id20}')" class="editable"><strong>${r20}</strong></td>`) : `<td data-label="Gotowe 20W">-</td>`;
        const cAssm = isViewer ? assm : `<td data-label="Surowe (W Montażu)" onclick="editCell(this, 'assembly', '${a.idAssm}')" class="editable">${assm}</td>`;
        tbImp.innerHTML += `<tr><td data-label="Kąt Oprawy"><strong>${a.name}</strong></td>${isViewer?`<td data-label="Gotowe 15W">${c15}</td>`:c15}${isViewer?(a.id20?`<td data-label="Gotowe 20W">${c20}</td>`:c20):c20}${isViewer?`<td data-label="Surowe">${cAssm}</td>`:cAssm}<td data-label="Serwis">${totSer}</td><td data-label="Łącznie"><strong>${total}</strong></td><td data-label="Dostępność"><span class="status-badge ${getStatusClass(a.id15)}">${getStatusText(a.id15)}</span></td></tr>`;
    });

    [{ name: 'PXF 22°', id15: 6, id20: null, idAssm: 6 }, { name: 'PXF 37°', id15: 7, id20: 9, idAssm: 7 }, { name: 'PXF 58°', id15: 8, id20: 10, idAssm: 8 }].forEach(a => {
        const p15 = getP(a.id15); const p20 = a.id20 ? getP(a.id20) : null; const pAssm = getP(a.idAssm);
        const r15 = parseInt(p15.ready) || 0; const r20 = p20 ? (parseInt(p20.ready) || 0) : 0; const assm = parseInt(pAssm.assembly) || 0;
        const s15 = (parseInt(p15.service)||0) + (parseInt(p15.damaged)||0); const s20 = p20 ? ((parseInt(p20.service)||0) + (parseInt(p20.damaged)||0)) : 0;
        const totSer = s15 + s20; const total = r15 + r20 + assm + totSer;
        const c15 = isViewer ? `<strong>${r15}</strong>` : `<td data-label="Gotowe 15W" onclick="editCell(this, 'ready', '${a.id15}')" class="editable"><strong>${r15}</strong></td>`;
        const c20 = a.id20 ? (isViewer ? `<strong>${r20}</strong>` : `<td data-label="Gotowe 20W" onclick="editCell(this, 'ready', '${a.id20}')" class="editable"><strong>${r20}</strong></td>`) : `<td data-label="Gotowe 20W">-</td>`;
        const cAssm = isViewer ? assm : `<td data-label="Surowe (W Montażu)" onclick="editCell(this, 'assembly', '${a.idAssm}')" class="editable">${assm}</td>`;
        tbPxf.innerHTML += `<tr><td data-label="Kąt Oprawy"><strong style="color:#1E3A8A;">${a.name}</strong></td>${isViewer?`<td data-label="Gotowe 15W">${c15}</td>`:c15}${isViewer?(a.id20?`<td data-label="Gotowe 20W">${c20}</td>`:c20):c20}${isViewer?`<td data-label="Surowe">${cAssm}</td>`:cAssm}<td data-label="Serwis">${totSer}</td><td data-label="Łącznie"><strong>${total}</strong></td><td data-label="Dostępność"><span class="status-badge ${getStatusClass(a.id15)}">${getStatusText(a.id15)}</span></td></tr>`;
    });

    window.inventory.products.forEach(p => {
        const damaged = parseInt(p.damaged) || 0; const inService = parseInt(p.service) || 0;
        if(damaged === 0 && inService === 0) return; 
        let actionButtons = !isViewer ? `<div class="action-cell-flex"><button class="btn-small btn-secondary" onclick="openSendToServiceUI('${p.id}', '${p.name}', ${damaged})">Na naprawę</button><button class="btn-small btn-secondary" onclick="openReceiveFromServiceUI('${p.id}', '${p.name}', ${inService})">Odbierz</button></div>` : '';
        tbSrv.innerHTML += `<tr><td data-label="Model Oprawy"><strong>${escapeHTML(p.name)}</strong></td><td data-label="Uszkodzone" style="color:var(--accent-red); font-weight:700;">${damaged}</td><td data-label="W Serwisie" style="color:var(--info-status); font-weight:700;">${inService}</td><td data-label="Akcja" class="${isViewer ? 'admin-only-col' : ''}">${actionButtons}</td></tr>`;
    });
}

function updateAdjustmentsTable() {
    const tbody = document.getElementById('adjustments-table'); if(!tbody) return; tbody.innerHTML = '';
    window.inventory.adjustments.forEach(a => {
        let action = currentRole === 'admin' ? `<td data-label="Akcja"><button class="btn-small btn-secondary" onclick="deleteAdjustment('${a.id}')" style="margin:0;"><span class="material-symbols-outlined" style="color:var(--accent-red); margin:0;">delete</span></button></td>` : `<td class="admin-only-col"></td>`;
        tbody.innerHTML += `<tr><td data-label="Data Wyjazdu"><strong>${escapeHTML(a.date || '-')}</strong></td><td data-label="Miejscowość">${escapeHTML(a.location)}</td>${action}</tr>`;
    });
}

function updateHistoryTable() {
    const tbody = document.getElementById('history-table'); if(!tbody) return; tbody.innerHTML = '';
    window.inventory.history.forEach(h => {
        const match = (h.details || '').match(/\(przez: (.*?)\)/); const worker = match ? match[1] : 'System'; const cleanDetails = (h.details || '').replace(/\(przez:.*?\)/, '').trim();
        tbody.innerHTML += `<tr><td data-label="Data i Czas" style="color:var(--text-light); font-size:0.85em;">${escapeHTML(h.timestamp)}</td><td data-label="Pracownik"><strong>${escapeHTML(worker)}</strong></td><td data-label="Typ Operacji">${escapeHTML(h.action)}</td><td data-label="Szczegóły">${escapeHTML(cleanDetails)}</td></tr>`;
    });
}

function updateServiceCasesTable() {
    const tbody = document.getElementById('service-cases-table'); if(!tbody) return; tbody.innerHTML = '';
    if (!window.inventory.serviceCases || window.inventory.serviceCases.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 2rem !important; color: gray;">Brak historii serwisowej.</td></tr>'; return; }
    window.inventory.serviceCases.forEach(c => {
        let badgeClass = c.action_type === 'Przyjęcie z RMA' ? 'status-warning' : (c.action_type === 'Odbiór z Serwisu' ? 'status-ok' : 'status-neutral');
        tbody.innerHTML += `<tr><td data-label="Data"><strong>${new Date(c.created_at).toLocaleDateString('pl-PL')}</strong></td><td data-label="Typ Akcji"><span class="status-badge ${badgeClass}">${escapeHTML(c.action_type)}</span></td><td data-label="Model Oprawy">${escapeHTML(c.product_name)}</td><td data-label="Ilość"><strong>${c.quantity} szt.</strong></td><td data-label="Notatka">${escapeHTML(c.description || '-')}</td></tr>`;
    });
}

function updateComponentsDisplay() {
    if(!window.inventory.components) return; const c = window.inventory.components;
    const els = { 'ps-raw-cell': c.ps_raw, 'clips-normal-cell': c.clips_normal, 'clips-pass-cell': c.clips_pass, 'reflector-22-cell': c.reflector_22, 'reflector-37-cell': c.reflector_37, 'reflector-58-cell': c.reflector_58 };
    for (const [id, val] of Object.entries(els)) { let el = document.getElementById(id); if (el) el.innerHTML = `<strong>${val || 0} szt.</strong>`; }
    ['stat-refl-22', 'stat-refl-37', 'stat-refl-58'].forEach((id, i) => { let el = document.getElementById(id); if (el) el.textContent = c[`reflector_${[22, 37, 58][i]}`] || 0; });
    if (currentRole !== 'viewer') { document.querySelectorAll('#tab-components .table-responsive td:nth-child(2)').forEach(td => td.classList.add('editable')); }
}

function getStatusClass(productId) { const status = window.inventory.getStatus(productId); return status === 'ok' ? 'status-ok' : status === 'warning' ? 'status-warning' : 'status-error'; }
function getStatusText(productId) { const status = window.inventory.getStatus(productId); return status === 'ok' ? '<span class="material-symbols-outlined">check_circle</span> OK' : status === 'warning' ? '<span class="material-symbols-outlined">warning</span> Mało' : '<span class="material-symbols-outlined">error</span> Brak'; }

function editCell(cell, field, productId) {
    if (currentRole === 'viewer') return; if (cell.querySelector('input')) return;
    const product = window.inventory.products.find(p => String(p.id) === String(productId));
    const input = document.createElement('input'); input.type = 'number'; input.value = product[field] || 0; input.style.width = '100%'; input.style.textAlign = 'inherit';
    const originalHTML = cell.innerHTML; cell.innerHTML = ''; cell.appendChild(input); cell.classList.remove('editable'); input.focus(); input.select();
    const save = async () => { const newValue = parseInt(input.value); if (!isNaN(newValue) && newValue !== (product[field]||0)) { cell.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite; color: var(--primary-terracotta);">autorenew</span>'; await window.inventory.updateProduct(productId, { [field]: newValue }); } else { cell.innerHTML = originalHTML; } cell.classList.add('editable'); };
    input.addEventListener('blur', save); input.addEventListener('keypress', (e) => { if (e.key === 'Enter') input.blur(); });
}

function editComponentCell(cell, field) {
    if (currentRole === 'viewer') return; if (cell.querySelector('input')) return;
    const currentVal = window.inventory.components[field] || 0;
    const input = document.createElement('input'); input.type = 'number'; input.value = currentVal; input.style.width = '100%'; input.style.textAlign = 'inherit';
    const originalHTML = cell.innerHTML; cell.innerHTML = ''; cell.appendChild(input); cell.classList.remove('editable'); input.focus(); input.select();
    const save = async () => { const newValue = parseInt(input.value); if (!isNaN(newValue) && newValue !== currentVal) { cell.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite; color: var(--primary-terracotta);">autorenew</span>'; await window.inventory.updateComponent(field, newValue); } else { cell.innerHTML = originalHTML; } cell.classList.add('editable'); };
    input.addEventListener('blur', save); input.addEventListener('keypress', (e) => { if (e.key === 'Enter') input.blur(); });
}

// --- FUNKCJE WYWOŁANIA Z UI ---
async function confirmShipmentDateUI(id) { if (confirm('Zatwierdzić termin wysyłki?')) { showLoading(); await window.inventory.confirmShipment(id); hideLoading(); showToast('Zatwierdzono', 'success'); } }
async function completeShipmentUI(id) { if (confirm(`Wydano towar z magazynu?`)) { showLoading(); await window.inventory.completeShipment(id); hideLoading(); showToast('Wydano towar', 'success'); } }
async function completeRemainingShipmentUI(id) { if (confirm('Wydano brakującą część towaru?')) { showLoading(); await window.inventory.completeRemainingShipment(id); hideLoading(); showToast('Zrealizowano', 'success'); } }
async function deleteShipment(id) { if (currentRole === 'admin' && confirm('Usunąć zamówienie?')) { showLoading(); await window.inventory.deleteShipment(id); hideLoading(); showToast('Usunięto', 'success'); } }
async function deleteAdjustment(id) { if (currentRole === 'admin' && confirm('Usunąć wpis z regulacji?')) { showLoading(); await window.inventory.deleteAdjustment(id); hideLoading(); showToast('Usunięto', 'success'); } }

// --- EDYCJA ZAMÓWIENIA W OKIENKU (MODAL) ---
function openShipmentDetails(id) {
    if (currentRole === 'viewer') return;
    const shipment = window.inventory.shipments.find(s => String(s.id) === String(id)); if (!shipment) return;
    const p = shipment.products || {}; const isPartial = shipment.status === 'partial'; const disableProducts = isPartial ? 'disabled' : '';
    const b = shipment.brand || 'imperial';
    const p1 = b==='pxf'?(p[6]||0):(p[1]||0); const p2 = b==='pxf'?(p[7]||0):(p[2]||0); const p3 = b==='pxf'?(p[8]||0):(p[3]||0); const p4 = b==='pxf'?(p[9]||0):(p[4]||0); const p5 = b==='pxf'?(p[10]||0):(p[5]||0);
    
    closeSidePanel(); 

    const content = `
        <div style="display: flex; flex-direction: column; gap: 1rem; text-align: left;">
            <div class="form-group"><label>Data Wysyłki</label><input type="date" id="edit_shipment_date" value="${escapeHTML(shipment.date)}"></div>
            <div class="form-group"><label>Pełny Cel / Adresat</label><input type="text" id="edit_shipment_location" value="${escapeHTML(shipment.location)}"></div>
            <div class="form-group"><label>Spedytor / Firma</label><input type="text" id="edit_shipment_company" value="${escapeHTML(shipment.company || '')}"></div>
            
            <div style="margin-top: 1rem; background-color: var(--bg-page); padding: 1rem; border-radius: 8px; border: 1px solid var(--border-color);">
                <h3 style="margin-bottom: 0.5rem; font-size: 0.8rem; color: var(--text-secondary); text-transform:uppercase;">Ilości Opraw</h3>
                ${isPartial ? '<p style="color: var(--error-text); font-size:0.75rem; margin-bottom:10px;">Edycja ilości zablokowana (wysyłka częściowa).</p>' : ''}
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                    <div class="form-group" style="margin:0;"><label>22° - 15W</label><input type="number" id="edit_p1" value="${p1}" min="0" ${disableProducts}></div>
                    <div class="form-group" style="margin:0;"><label>37° - 15W</label><input type="number" id="edit_p2" value="${p2}" min="0" ${disableProducts}></div>
                    <div class="form-group" style="margin:0;"><label>58° - 15W</label><input type="number" id="edit_p3" value="${p3}" min="0" ${disableProducts}></div>
                    <div class="form-group" style="margin:0;"><label>37° - 20W</label><input type="number" id="edit_p4" value="${p4}" min="0" ${disableProducts}></div>
                    <div class="form-group" style="margin:0;"><label>58° - 20W</label><input type="number" id="edit_p5" value="${p5}" min="0" ${disableProducts}></div>
                </div>
            </div>
            
            <button class="btn-primary" onclick="saveEditedShipment('${id}')" style="width:100%; margin-top: 1rem;"><span class="material-symbols-outlined">save</span> Zapisz Zmiany</button>
        </div>
    `;
    
    showModal(`Edycja: ${b.toUpperCase()}`, content);
}

window.saveEditedShipment = async function(id) {
    const newDate = document.getElementById('edit_shipment_date').value; 
    const newLocation = document.getElementById('edit_shipment_location').value; 
    const newCompany = document.getElementById('edit_shipment_company').value;
    if (!newDate || !newLocation) { showToast('Data i cel są wymagane.', 'error'); return; }
    
    const shipment = window.inventory.shipments.find(s => String(s.id) === String(id)); 
    const data = { date: newDate, location: newLocation, company: newCompany };
    
    if (shipment.status !== 'partial') {
        const brand = shipment.brand || 'imperial'; 
        if(brand === 'imperial') {
            data.products = { 1: parseInt(document.getElementById('edit_p1').value) || 0, 2: parseInt(document.getElementById('edit_p2').value) || 0, 3: parseInt(document.getElementById('edit_p3').value) || 0, 4: parseInt(document.getElementById('edit_p4').value) || 0, 5: parseInt(document.getElementById('edit_p5').value) || 0 };
        } else {
            data.products = { 6: parseInt(document.getElementById('edit_p1').value) || 0, 7: parseInt(document.getElementById('edit_p2').value) || 0, 8: parseInt(document.getElementById('edit_p3').value) || 0, 9: parseInt(document.getElementById('edit_p4').value) || 0, 10: parseInt(document.getElementById('edit_p5').value) || 0 };
        }
    }
    
    closeModal(); 
    showLoading(); 
    await window.inventory.updateShipmentInDB(id, data); 
    hideLoading(); 
    showToast('Zapisano zmiany.', 'success');
}

function showAnglesDemand(id) {
    const shipment = window.inventory.shipments.find(s => String(s.id) === String(id)); if(!shipment) return;
    const p = shipment.products || {}; const brand = shipment.brand || 'imperial';
    const a22 = brand === 'pxf' ? (parseInt(p[6])||0) : (parseInt(p[1])||0);
    const a37 = brand === 'pxf' ? (parseInt(p[7])||0) + (parseInt(p[9])||0) : (parseInt(p[2])||0) + (parseInt(p[4])||0);
    const a58 = brand === 'pxf' ? (parseInt(p[8])||0) + (parseInt(p[10])||0) : (parseInt(p[3])||0) + (parseInt(p[5])||0);
    const content = `<div style="text-align: center;"><p style="color: var(--text-light); margin-bottom: 1.5rem; font-size:0.95rem;">Zapotrzebowanie dla: <br><strong style="color:var(--text-dark); font-size:1.2rem;">${escapeHTML(shipment.location)}</strong></p><div style="display:flex; justify-content: space-around; background: var(--background); padding: 2rem 1rem; border-radius: 12px; border: 1px solid var(--border-color); box-shadow: inset 0 2px 4px rgba(0,0,0,0.03);"><div><div style="font-size: 0.8rem; color: var(--text-light); text-transform:uppercase; letter-spacing:1px; margin-bottom:5px; font-weight:600;">Kąt 22°</div><div style="font-size: 2.5rem; font-weight: 700; color:var(--primary-dark);">${a22}</div></div><div><div style="font-size: 0.8rem; color: var(--text-light); text-transform:uppercase; letter-spacing:1px; margin-bottom:5px; font-weight:600;">Kąt 37°</div><div style="font-size: 2.5rem; font-weight: 700; color:var(--primary-dark);">${a37}</div></div><div><div style="font-size: 0.8rem; color: var(--text-light); text-transform:uppercase; letter-spacing:1px; margin-bottom:5px; font-weight:600;">Kąt 58°</div><div style="font-size: 2.5rem; font-weight: 700; color:var(--primary-dark);">${a58}</div></div></div></div>`;
    showModal('Zestawienie Kątowe', content);
}

function openReceiveDamagedUI() {
    let opts = window.inventory.products.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    let html = `<div class="form-group"><label>Model oprawy (zwrot)</label><select id="rma_prod_id" style="width:100%; padding:0.75rem; border-radius:10px; font-family:'Inter',sans-serif; border:1px solid #D1D5DB;">${opts}</select></div><div class="form-group"><label>Zwróconych (uszkodzonych) sztuk</label><input type="number" id="rma_qty" min="1" value="1"></div><div class="form-group" style="background:#ECFDF5; padding:1rem; border-radius:8px; border:1px solid #A7F3D0;"><label style="color:#065F46; font-size:0.8rem;">Odzyskanych zasilaczy?</label><input type="number" id="rma_salvaged" min="0" value="0"></div><div class="form-group"><label>Opis usterki</label><input type="text" id="rma_desc" placeholder="np. uszkodzony klosz..."></div><button class="btn-primary" onclick="submitDamagedReturn()" style="width:100%; margin-top:10px;"><span class="material-symbols-outlined">assignment_return</span> Przyjmij zwrot</button>`;
    showModal('Przyjęcie zwrotu RMA', html);
}
window.submitDamagedReturn = async function() { let id = document.getElementById('rma_prod_id').value; let qty = parseInt(document.getElementById('rma_qty').value)||0; let sal = parseInt(document.getElementById('rma_salvaged').value)||0; let desc = document.getElementById('rma_desc').value.trim(); if(qty>0) { closeModal(); showLoading(); await window.inventory.processDamagedReturn(id, qty, sal, desc); hideLoading(); } }

function openSendToServiceUI(id, name, available) {
    let html = `<p style="margin-bottom:1rem; font-size:0.95rem;">Wysyłasz oprawy <strong>${name}</strong> na naprawę. Dostępne (uszkodzone): <strong>${available}</strong> szt.</p><div class="form-group"><label>Ilość do wydania:</label><input type="number" id="rma_send_qty" min="1" max="${available}" value="1"></div><div class="form-group"><label>Opis / Notatka</label><input type="text" id="rma_send_desc" placeholder="np. wysłano DPD..."></div><button class="btn-primary" onclick="submitSendService('${id}')" style="width:100%;"><span class="material-symbols-outlined">handyman</span> Wydaj do Serwisu</button>`;
    showModal('Wydanie na naprawę', html);
}
window.submitSendService = async function(id) { let qty = parseInt(document.getElementById('rma_send_qty').value)||0; let desc = document.getElementById('rma_send_desc').value.trim(); if(qty>0) { closeModal(); showLoading(); await window.inventory.sendToService(id, qty, desc); hideLoading(); } }

function openReceiveFromServiceUI(id, name, inService) {
    let html = `<p style="margin-bottom:1rem; font-size:0.95rem;">Odbierasz oprawy <strong>${name}</strong> po naprawie. W serwisie: <strong>${inService}</strong> szt.</p><div class="form-group"><label>Odebranych sztuk:</label><input type="number" id="rma_rec_qty" min="1" max="${inService}" value="1"></div><div class="form-group" style="background:#FEF2F2; padding:1rem; border-radius:8px; border:1px solid #FECACA;"><label style="color:#991B1B; font-size:0.8rem;">Zużytych NOWYCH zasilaczy?</label><input type="number" id="rma_used_ps" min="0" value="0"></div><div class="form-group"><label>Notatka</label><input type="text" id="rma_rec_desc" placeholder="..."></div><button class="btn-primary" onclick="submitReceiveService('${id}')" style="width:100%; margin-top:10px;"><span class="material-symbols-outlined">task_alt</span> Zakończ Naprawę</button>`;
    showModal('Odbiór z naprawy', html);
}
window.submitReceiveService = async function(id) { let qty = parseInt(document.getElementById('rma_rec_qty').value)||0; let used = parseInt(document.getElementById('rma_used_ps').value)||0; let desc = document.getElementById('rma_rec_desc').value.trim(); if(qty>0) { closeModal(); showLoading(); await window.inventory.receiveFromService(id, qty, used, desc); hideLoading(); } }

function showMissingItems(id) {
    if (!window.inventory) return; const s = window.inventory.shipments.find(x => String(x.id) === String(id)); if (!s || !s.partial_missing) return;
    let c = `<div style="margin-bottom:1rem; padding:1.5rem; background:#F9FAFB; border-radius:12px; border:1px solid #E5E7EB;">Cel wysyłki: <b>${escapeHTML(s.location)}</b><br>Data wyjazdu: ${s.date}</div><div class="table-responsive" style="margin-bottom:1.5rem;"><table style="width:100%;"><thead><tr><th style="text-align:left;">Model Oprawy</th><th>Ilość Brakująca</th></tr></thead><tbody>`;
    let tot = 0; Object.entries(s.partial_missing).forEach(([pid, qty]) => { const p = window.inventory.products.find(x => String(x.id) === String(pid)); if(p) { c += `<tr><td>${p.name}</td><td style="color:var(--accent-red); font-weight:bold; text-align:center;">${qty} szt.</td></tr>`; tot += qty; } });
    c += `</tbody></table></div><div style="display:flex; justify-content:space-between; align-items:center;"><b>Łącznie do dosłania: <span style="color:var(--accent-red); font-size:1.2em;">${tot} szt.</span></b><button class="btn-primary" onclick="printMissingPdf('${id}')"><span class="material-symbols-outlined">print</span> Drukuj Raport</button></div>`;
    showModal('Szczegóły Braków', c);
}

function printMissingPdf(id) {
    const s = window.inventory.shipments.find(x => String(x.id) === String(id)); if (!s || !s.partial_missing) return;
    let h = `<html><body style="font-family:sans-serif; padding:40px;"><h2>Lista Braków do Dosłania</h2><p><b>Miejsce docelowe:</b> ${escapeHTML(s.location)}<br><b>Data pierwotna:</b> ${s.date}</p><table style="width:100%; border-collapse:collapse; margin-top:20px;"><tr><th style="text-align:left; border-bottom:2px solid #000; padding:8px;">Oprawa</th><th style="border-bottom:2px solid #000; padding:8px; text-align:center;">Brakująca ilość</th></tr>`;
    let t = 0; Object.entries(s.partial_missing).forEach(([pid, qty]) => { const p = window.inventory.products.find(x => String(x.id) === String(pid)); if(p) { h += `<tr><td style="border-bottom:1px solid #ddd; padding:8px;">${p.name}</td><td style="border-bottom:1px solid #ddd; padding:8px; font-weight:bold; color:red; text-align:center;">${qty} szt.</td></tr>`; t+=qty; } });
    h += `</table><p style="text-align:right; font-size:1.2em; margin-top:20px;"><b>Suma sztuk do dosłania: <span style="color:red;">${t}</span></b></p><br><br>Podpis magazyniera: .........................</body></html>`;
    const w = window.open('', '', 'width=800,height=600'); w.document.write(h); w.document.close(); setTimeout(() => { w.print(); w.close(); }, 300);
}

function printInventoryPdf() {
    if(!window.inventory || window.inventory.products.length === 0) return;
    const d = new Date().toLocaleDateString('pl-PL'); const t = window.inventory.getTotals();
    let h = `<html><head><title>Raport Inwentaryzacji</title><style>body{font-family:sans-serif;margin:40px;}table{width:100%;border-collapse:collapse;margin:20px 0;}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left;}</style></head><body><h2>Stan Magazynu Masterlight (${d})</h2><table><tr><th>Kąt Oprawy</th><th>Gotowe 15W</th><th>Gotowe 20W</th><th>Surowe</th><th>Serwis</th><th>Suma Całkowita</th></tr>`;
    
    const getP = (id) => window.inventory.products.find(x => String(x.id) === String(id)) || {};
    [{ name: 'IMPERIAL 22°', id15: 1, id20: null, idAssm: 1 }, { name: 'IMPERIAL 37°', id15: 2, id20: 4, idAssm: 2 }, { name: 'IMPERIAL 58°', id15: 3, id20: 5, idAssm: 3 }].forEach(a => { 
        const p15 = getP(a.id15); const p20 = a.id20 ? getP(a.id20) : null; const pAssm = getP(a.idAssm);
        const r15 = parseInt(p15.ready)||0; const r20 = p20 ? (parseInt(p20.ready)||0) : 0; const assm = parseInt(pAssm.assembly)||0;
        const s15 = parseInt(p15.service)||0 + parseInt(p15.damaged)||0; const s20 = p20 ? (parseInt(p20.service)||0 + parseInt(p20.damaged)||0) : 0; const totSer = s15 + s20; const total = r15 + r20 + assm + totSer;
        h += `<tr><td>${a.name}</td><td>${r15}</td><td>${a.id20 ? r20 : '-'}</td><td>${assm}</td><td>${totSer}</td><td><b>${total}</b></td></tr>`; 
    });
    [{ name: 'PXF 22°', id15: 6, id20: null, idAssm: 6 }, { name: 'PXF 37°', id15: 7, id20: 9, idAssm: 7 }, { name: 'PXF 58°', id15: 8, id20: 10, idAssm: 8 }].forEach(a => { 
        const p15 = getP(a.id15); const p20 = a.id20 ? getP(a.id20) : null; const pAssm = getP(a.idAssm);
        const r15 = parseInt(p15.ready)||0; const r20 = p20 ? (parseInt(p20.ready)||0) : 0; const assm = parseInt(pAssm.assembly)||0;
        const s15 = parseInt(p15.service)||0 + parseInt(p15.damaged)||0; const s20 = p20 ? (parseInt(p20.service)||0 + parseInt(p20.damaged)||0) : 0; const totSer = s15 + s20; const total = r15 + r20 + assm + totSer;
        h += `<tr><td style="color:#1E3A8A;">${a.name}</td><td>${r15}</td><td>${a.id20 ? r20 : '-'}</td><td>${assm}</td><td>${totSer}</td><td><b>${total}</b></td></tr>`; 
    });
    h += `<tr><td colspan="5" align="right"><b>ŁĄCZNIE MODUŁÓW (SUROWE+GOTOWE+SERWIS):</b></td><td><b>${t.totalAll}</b></td></tr></table><br><br>Podpis magazyniera: .........................</body></html>`;

    const w = window.open('', '', 'width=800,height=600'); w.document.write(h); w.document.close(); setTimeout(() => { w.print(); w.close(); }, 300);
}

// --- KALENDARZ I MAPA (LEAFLET) ---
function changeMonth(dir) { currentCalendarDate.setMonth(currentCalendarDate.getMonth() + dir); if(window.inventory) window.inventory.updateDashboard(); }
function handleDragStart(event, type, id) { event.dataTransfer.setData('application/json', JSON.stringify({ type, id })); event.dataTransfer.effectAllowed = 'move'; }
async function handleCalendarDrop(event, targetDate) {
    event.preventDefault(); if (currentRole === 'viewer') { showToast('Brak uprawnień.', 'warning'); return; }
    try {
        const dataStr = event.dataTransfer.getData('application/json'); if (!dataStr) return;
        const data = JSON.parse(dataStr); if (!data.type || !data.id) return;
        showLoading();
        if (data.type === 'shipment') { await window.inventory.updateShipmentInDB(data.id, { date: targetDate }); showToast('Przesunięto wysyłkę.', 'success'); } 
        else if (data.type === 'adjustment') { await window.inventory.updateAdjustmentDate(data.id, targetDate); showToast('Przesunięto serwis.', 'success'); }
    } catch (e) { showToast('Błąd przenoszenia.', 'error'); } finally { hideLoading(); }
}

function renderCalendar(readinessMap) {
    const container = document.getElementById('dashboard-calendar-container'); const monthLabel = document.getElementById('calendar-month-label'); if(!container) return;
    const year = currentCalendarDate.getFullYear(); const month = currentCalendarDate.getMonth(); const monthNames = ["Styczeń","Luty","Marzec","Kwiecień","Maj","Czerwiec","Lipiec","Sierpień","Wrzesień","Październik","Listopad","Grudzień"];
    monthLabel.textContent = `${monthNames[month]} ${year}`; container.innerHTML = '';
    let firstDay = new Date(year, month, 1).getDay(); firstDay = firstDay === 0 ? 6 : firstDay - 1; const daysInMonth = new Date(year, month + 1, 0).getDate();
    let dayCounter = 1, isMonthFinished = false;
    while (!isMonthFinished) {
        const row = document.createElement('div'); row.className = 'calendar-grid'; let weekTotal = 0;
        for (let j = 0; j < 7; j++) {
            const cell = document.createElement('div');
            if (dayCounter === 1 && j < firstDay) { cell.className = 'calendar-cell empty'; } 
            else if (dayCounter > daysInMonth) { cell.className = 'calendar-cell empty'; isMonthFinished = true; } 
            else {
                cell.className = 'calendar-cell'; const ds = `${year}-${String(month + 1).padStart(2,'0')}-${String(dayCounter).padStart(2,'0')}`;
                cell.ondragover = (e) => e.preventDefault(); cell.ondrop = (e) => handleCalendarDrop(e, ds);
                if (ds === new Date().toISOString().split('T')[0]) cell.classList.add('today');
                let html = `<div class="calendar-date">${dayCounter}</div>`;
                if(window.inventory && window.inventory.shipments) {
                    window.inventory.shipments.filter(s => s.status !== 'completed' && s.date === ds).forEach(s => {
                        const tot = s.products ? Object.values(s.products).reduce((a,b)=>parseInt(a||0)+parseInt(b||0),0) : 0; weekTotal += tot;
                        let st = s.status === 'partial' ? '<span style="color:var(--warning-status);">Braki (Część.)</span>' : (readinessMap[s.id] ? '<span style="color:var(--success-status);">Komplet</span>' : '<span style="color:var(--accent-red);">Braki</span>');
                        html += `<div class="cal-item shipment" draggable="true" ondragstart="handleDragStart(event, 'shipment', '${s.id}')" onclick="openShipmentDetails('${s.id}')"><strong>W: ${escapeHTML(s.location).split('(')[0]}</strong><br>${tot} szt<br>${st}</div>`;
                    });
                }
                if(window.inventory && window.inventory.adjustments) {
                    window.inventory.adjustments.filter(a => a.date === ds).forEach(a => { html += `<div class="cal-item adjustment" draggable="true" ondragstart="handleDragStart(event, 'adjustment', '${a.id}')"><strong>R: ${escapeHTML(a.location).split('(')[0]}</strong><br>Serwis</div>`; });
                }
                cell.innerHTML = html; dayCounter++;
            }
            row.appendChild(cell);
        }
        if (!isMonthFinished || row.childNodes[0].className !== 'calendar-cell empty') {
            const sum = document.createElement('div'); sum.className = 'cal-summary'; sum.innerHTML = `<span style="font-size:0.7rem;color:var(--text-light);">POTRZEBA</span><span style="font-size:1.4rem;">${weekTotal}</span><span style="font-size:0.7rem;">szt</span>`;
            row.appendChild(sum); container.appendChild(row);
        }
    }
}

const boundsPoland = L.latLngBounds(L.latLng(48.9, 14.1), L.latLng(54.9, 24.2));
function initMap() { if (map) return; map = L.map('shipments-map', { zoomControl: false, scrollWheelZoom: false, dragging: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, maxBounds: boundsPoland, minZoom: 5, maxZoom: 9 }).setView([51.7592, 19.4560], 6); L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map); }
function initAdjMap() { if (mapAdj) return; mapAdj = L.map('adjustments-map', { zoomControl: false, scrollWheelZoom: false, dragging: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, maxBounds: boundsPoland, minZoom: 5, maxZoom: 9 }).setView([51.7592, 19.4560], 6); L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(mapAdj); }
async function geocodeLocation(locationStr) {
    let searchStr = locationStr.split('(')[0].trim(); if (geocodeCache[searchStr]) return geocodeCache[searchStr];
    try { let res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchStr)}&countrycodes=pl&limit=1`); let data = await res.json(); if (data && data.length > 0) { geocodeCache[searchStr] = [data[0].lat, data[0].lon]; return geocodeCache[searchStr]; } } catch (e) { } geocodeCache[searchStr] = null; return null;
}

async function updateMapMarkers(shipments, adjustments) {
    if (isUpdatingMap || !window.inventory) return; isUpdatingMap = true;
    try {
        if (!map) initMap(); const statusEl = document.getElementById('map-status'); if(statusEl) statusEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:1em; animation: spin 1s linear infinite;">autorenew</span> Rysowanie tras...';
        mapMarkers.forEach(m => map.removeLayer(m)); mapMarkers = [];
        const homeMarker = L.marker([51.7592, 19.4560], {icon: L.divIcon({html: `<div class="custom-map-marker marker-home" style="width:28px; height:28px;"><span class="material-symbols-outlined" style="font-size:16px;">home</span></div>`, className: '', iconSize: [28,28], iconAnchor: [14,14]})}).addTo(map).bindPopup('<b>Baza Masterlight</b>');
        const allPoints = [homeMarker]; let tasks = [];
        (shipments || []).filter(s => s.status !== 'completed').forEach(s => { tasks.push({ ...s, type: 'Wysyłka' }); });
        (adjustments || []).forEach(a => { tasks.push({ ...a, type: 'Regulacja' }); });
        tasks.sort((a, b) => (a.date || '').localeCompare(b.date || '')); let shipCounter = 1; let adjCounter = 1;
        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i]; if(!t.location) continue; const coords = await geocodeLocation(t.location);
            if (coords) {
                let mClass = '', title = '', details = '', displayNum = 0;
                if (t.type === 'Wysyłka') { displayNum = shipCounter++; const total = t.products ? Object.values(t.products).reduce((a, b) => parseInt(a) + parseInt(b), 0) : 0; mClass = t.is_confirmed ? 'marker-confirmed' : 'marker-planned'; title = 'Wysyłka'; details = `Sztuk: <strong>${total}</strong><br>Spedytor: ${escapeHTML(t.company)}`; } 
                else { displayNum = adjCounter++; mClass = 'marker-adjustment'; title = 'Regulacja'; details = 'Wyjazd Serwisowy'; }
                const popupText = `<b>${escapeHTML(t.location)}</b><br><span style="font-size:0.85rem;color:gray;">[#${displayNum}] ${title}</span><br>Termin: ${escapeHTML(t.date)}<br>${details}`;
                const marker = L.marker(coords, { icon: L.divIcon({html: `<div class="custom-map-marker ${mClass}" style="width:24px; height:24px; font-size:11px;">${displayNum}</div>`, className: '', iconSize: [24,24], iconAnchor: [12,12]})}).addTo(map).bindPopup(popupText);
                mapMarkers.push(marker); allPoints.push(marker);
            } await new Promise(r => setTimeout(r, 150));
        }
        if (allPoints.length > 1) { map.fitBounds(new L.featureGroup(allPoints).getBounds(), { padding: [50, 50], maxZoom: 9 }); } else { map.setView([51.7592, 19.4560], 6); }
        if(statusEl) statusEl.innerHTML = '<span class="material-symbols-outlined" style="color: var(--success-status);">check_circle</span> Gotowa';
    } catch(e) { console.error(e); } finally { isUpdatingMap = false; }
}

async function updateAdjMapMarkers(adjustments) {
    try {
        if (!mapAdj) initAdjMap(); mapAdjMarkers.forEach(m => mapAdj.removeLayer(m)); mapAdjMarkers = [];
        const homeMarker = L.marker([51.7592, 19.4560], {icon: L.divIcon({html: `<div class="custom-map-marker marker-home" style="width:28px; height:28px;"><span class="material-symbols-outlined" style="font-size:16px;">home</span></div>`, className: '', iconSize: [28,28], iconAnchor: [14,14]})}).addTo(mapAdj).bindPopup('<b>Baza Masterlight</b>');
        const allPoints = [homeMarker]; let sortedAdjs = [...(adjustments||[])].sort((a,b) => (a.date||'').localeCompare(b.date||''));
        for (let i = 0; i < sortedAdjs.length; i++) { const coords = await geocodeLocation(sortedAdjs[i].location); if (coords) { const marker = L.marker(coords, { icon: L.divIcon({html: `<div class="custom-map-marker marker-adjustment" style="width:24px; height:24px; font-size:11px;">${i+1}</div>`, className: '', iconSize: [24,24], iconAnchor: [12,12]})}).addTo(mapAdj).bindPopup(`<b>${escapeHTML(sortedAdjs[i].location)}</b><br>Serwis: ${escapeHTML(sortedAdjs[i].date)}`); mapAdjMarkers.push(marker); allPoints.push(marker); } await new Promise(r => setTimeout(r, 100)); }
        if (allPoints.length > 1) mapAdj.fitBounds(new L.featureGroup(allPoints).getBounds(), { padding: [50, 50], maxZoom: 9 });
    } catch(e) {}
}

window.scanOfferFromPDF = async function(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { showToast('Proszę wgrać plik PDF.', 'error'); document.getElementById('pdf-input').value = ''; return; }
    const btn = document.getElementById('pdf-scan-btn'); const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">autorenew</span> Skanowanie...'; btn.disabled = true;
    try {
        const arrayBuffer = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise; let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) { const page = await pdf.getPage(i); const content = await page.getTextContent(); fullText += content.items.map(item => item.str).join(' ') + '\n'; }
        let p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0; let target = ""; let city = "";
        const matchSklep = fullText.match(/Sklep nr\s*(\d+)/i); if (matchSklep) target = "ROSSMANN Sklep nr " + matchSklep[1];
        const lines = fullText.split('\n');
        lines.forEach(line => {
            if (line.toUpperCase().includes('VIGO')) {
                const words = line.trim().split(/\s+/); let qty = parseInt(words[words.length - 1]); if (isNaN(qty) && words.length > 1) qty = parseInt(words[words.length - 2]); if (isNaN(qty)) qty = 0;
                let upperLine = line.toUpperCase(); let is15W = upperLine.includes("15W") || upperLine.includes("15 W"); let is20WPlus = upperLine.includes("20W") || upperLine.includes("26W") || upperLine.includes("33W");
                let is22 = upperLine.includes("22") || upperLine.includes("G3"); let is58 = upperLine.includes("58") || upperLine.includes("235") || upperLine.includes("G1") || upperLine.includes("G5"); let is37 = upperLine.includes("37") || upperLine.includes("140") || upperLine.includes("185") || upperLine.includes("G2") || upperLine.includes("G4") || (!is22 && !is58);
                if (is15W) { if (is22) p1 += qty; else if (is58) p3 += qty; else p2 += qty; } else if (is20WPlus) { if (is58) p5 += qty; else p4 += qty; }
            }
        });
        document.getElementById('form-city').value = city; document.getElementById('form-target').value = target; document.getElementById('form-date').value = new Date().toISOString().split('T')[0]; document.getElementById('form-company').value = "Do ustalenia";
        document.getElementById('form-p1').value = p1; document.getElementById('form-p2').value = p2; document.getElementById('form-p3').value = p3; document.getElementById('form-p4').value = p4; document.getElementById('form-p5').value = p5;
        showToast('PDF przeskanowany! Wybierz pulę (Imperial/PXF).', 'success');
    } catch (error) { showModal('Błąd odczytu PDF', `<p style="color:var(--accent-red); font-weight:500;">Nie udało się przetworzyć pliku.</p>`); } 
    finally { btn.innerHTML = originalText; btn.disabled = false; document.getElementById('pdf-input').value = ''; }
}
