// Konfiguracja Supabase
const supabaseUrl = 'https://ghdswvjhqpxupzcrixlu.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZHN3dmpocXB4dXB6Y3JpeGx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NTEwMDAsImV4cCI6MjA4NzQyNzAwMH0._sk7mCv27tC153DTvqp_7O3CUyYsk3iuYuf0f93GCfo';
const db = window.supabase.createClient(supabaseUrl, supabaseKey);

// Matryca powiązań Imperial (ID lampy -> ID surowych obudów)
const imperialAngleMap = { 
    '1': ['1'],       // 22°
    '2': ['2', '4'],  // 37° (dzielone przez 15W i 20W)
    '3': ['3', '5'],  // 58° (dzielone przez 15W i 20W)
    '4': ['2', '4'],
    '5': ['3', '5']
};

class InventoryManager {
    constructor() {
        this.products = [];
        this.components = {};
        this.shipments = [];
    }

    async init() {
        showLoading();
        await this.fetchData();
        this.setupRealtime();
        this.bindEvents();
        hideLoading();
    }

    async fetchData() {
        try {
            const [pRes, cRes, sRes] = await Promise.all([
                db.from('products').select('*').order('id'),
                db.from('components').select('*').eq('id', 1).single(),
                db.from('shipments').select('*').order('date', { ascending: false })
            ]);

            this.products = pRes.data || [];
            this.components = cRes.data || {};
            this.shipments = sRes.data || [];

            this.renderAll();
        } catch (err) {
            showToast("Błąd pobierania danych z bazy", "error");
        }
    }

    setupRealtime() {
        db.channel('wms-updates').on('postgres_changes', { event: '*', schema: 'public' }, () => this.fetchData()).subscribe();
    }

    // --- RENDEROWANIE INTERFEJSU ---
    renderAll() {
        this.renderDashboard();
        this.renderInventory();
        this.renderComponents();
        // Wywołaj tutaj inne funkcje renderujące (wysyłki, etc.)
    }

    renderDashboard() {
        const stats = {
            total: this.products.reduce((a, b) => a + (b.ready || 0) + (b.assembly || 0), 0),
            pxf: this.products.filter(p => p.id >= 6).reduce((a, b) => a + (b.ready || 0), 0),
            imperial: this.products.filter(p => p.id <= 5).reduce((a, b) => a + (b.ready || 0), 0)
        };

        document.querySelector('[data-stat="total"]').textContent = stats.total;
        document.querySelector('[data-stat="ready-pxf"]').textContent = stats.pxf;
        document.querySelector('[data-stat="ready-imperial"]').textContent = stats.imperial;
    }

    renderInventory() {
        const impTable = document.getElementById('products-imperial-table');
        const pxfTable = document.getElementById('products-pxf-table');
        if (!impTable || !pxfTable) return;

        impTable.innerHTML = '';
        pxfTable.innerHTML = '';

        this.products.forEach(p => {
            const row = `<tr>
                <td>${p.name}</td>
                <td><strong>${p.ready || 0}</strong></td>
                ${p.id <= 5 ? `<td>${p.assembly || 0}</td>` : ''}
                <td>${(p.ready || 0) + (p.assembly || 0)}</td>
            </tr>`;

            if (p.id <= 5) impTable.innerHTML += row;
            else pxfTable.innerHTML += row;
        });
    }

    renderComponents() {
        const c = this.components;
        const container = document.getElementById('tab-components');
        if (!container) return;

        // Przykładowe wstrzyknięcie wartości do Twoich komórek (id z index.html)
        const psCell = document.getElementById('ps-raw-cell');
        if (psCell) psCell.textContent = c.ps_raw + " szt.";
    }

    // --- LOGIKA PRODUKCJI IMPERIAL ---
    async registerProduction(prodData) {
        showLoading();
        const updates = [];
        let totalQty = 0;
        const angleDeductions = { '1': 0, '2': 0, '3': 0 };

        for (const [id, qty] of Object.entries(prodData)) {
            const q = parseInt(qty) || 0;
            if (q <= 0) continue;
            totalQty += q;

            if (id === '1') angleDeductions['1'] += q;
            if (id === '2' || id === '4') angleDeductions['2'] += q;
            if (id === '3' || id === '5') angleDeductions['3'] += q;

            const p = this.products.find(x => String(x.id) === id);
            updates.push(db.from('products').update({ ready: (p.ready || 0) + q }).eq('id', id));
        }

        for (const [masterId, deduction] of Object.entries(angleDeductions)) {
            if (deduction <= 0) continue;
            const p = this.products.find(x => String(x.id) === masterId);
            const newAssembly = (p.assembly || 0) - deduction;
            imperialAngleMap[masterId].forEach(targetId => {
                updates.push(db.from('products').update({ assembly: newAssembly }).eq('id', targetId));
            });
        }

        // Zużycie komponentów
        const newComps = {
            ps_raw: this.components.ps_raw - totalQty,
            clips_normal: this.components.clips_normal - totalQty,
            clips_pass: this.components.clips_pass - totalQty
        };
        updates.push(db.from('components').update(newComps).eq('id', 1));

        await Promise.all(updates);
        showToast(`Produkcja zakończona: +${totalQty} opraw`, "success");
        await this.fetchData();
        hideLoading();
    }

    bindEvents() {
        // Tu podpinamy formularze, np:
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.onsubmit = async (e) => {
                e.preventDefault();
                const email = document.getElementById('login-email').value;
                const pass = document.getElementById('login-password').value;
                const { error } = await db.auth.signInWithPassword({ email, password: pass });
                if (error) {
                    const errEl = document.getElementById('login-error');
                    errEl.textContent = "Błąd logowania!";
                    errEl.style.display = "block";
                } else {
                    window.location.reload();
                }
            };
        }
    }
}

// --- FUNKCJE GLOBALNE ---

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    event.currentTarget.classList.add('active');
    
    document.getElementById('page-title').textContent = event.currentTarget.textContent;
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('open');
}

function showLoading() { document.getElementById('loading-screen').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading-screen').classList.add('hidden'); }

// Start
window.inventory = new InventoryManager();
window.inventory.init();
