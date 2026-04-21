// app.js
const supabaseUrl = 'https://ghdswvjhqpxupzcrixlu.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoZHN3dmpocXB4dXB6Y3JpeGx1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NTEwMDAsImV4cCI6MjA4NzQyNzAwMH0._sk7mCv27tC153DTvqp_7O3CUyYsk3iuYuf0f93GCfo';
const db = window.supabase.createClient(supabaseUrl, supabaseKey);

// MATRYCA KĄTÓW (Łączy modele Imperial i ich surowe obudowy)
const imperialAngleMap = { 
    '1': ['1'],       // Kąt 22
    '2': ['2', '4'],  // Kąt 37 (15W i 20W korzystają z ID 2)
    '3': ['3', '5'],  // Kąt 58 (15W i 20W korzystają z ID 3)
    '4': ['2', '4'],  // Rewers dla 20W
    '5': ['3', '5']   // Rewers dla 20W
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
        hideLoading();
    }

    async fetchData() {
        const pRes = await db.from('products').select('*').order('id');
        const cRes = await db.from('components').select('*').eq('id', 1).single();
        const sRes = await db.from('shipments').select('*').order('date');
        
        this.products = pRes.data || [];
        this.components = cRes.data || {};
        this.shipments = sRes.data || [];
        
        this.renderAll();
    }

    setupRealtime() {
        db.channel('any').on('postgres_changes', { event: '*', schema: 'public' }, () => this.fetchData()).subscribe();
    }

    // --- NOWA LOGIKA PRODUKCJI (NAPRAWA BŁĘDU ODEJMOWANIA) ---
    async registerProduction(prodData) {
        showLoading();
        const updates = [];
        let totalQty = 0;

        // 1. Grupowanie ubytku obudów po kątach (zabezpieczenie przed dublowaniem)
        const angleDeductions = { '1': 0, '2': 0, '3': 0 };

        for (const [id, qty] of Object.entries(prodData)) {
            const q = parseInt(qty) || 0;
            if (q <= 0) continue;

            totalQty += q;
            // Sprawdź w matrycy, który "master ID" (1, 2 lub 3) odpowiada za ten kąt
            if (id === '1') angleDeductions['1'] += q;
            if (id === '2' || id === '4') angleDeductions['2'] += q;
            if (id === '3' || id === '5') angleDeductions['3'] += q;

            // Dodaj gotowe lampy (indywidualnie dla każdego modelu)
            const p = this.products.find(x => String(x.id) === id);
            const newReady = (p.ready || 0) + q;
            updates.push(db.from('products').update({ ready: newReady }).eq('id', id));
        }

        // 2. Odejmij surowe obudowy zbiorczo (Raz na kąt)
        for (const [masterId, deduction] of Object.entries(angleDeductions)) {
            if (deduction <= 0) continue;
            const p = this.products.find(x => String(x.id) === masterId);
            const newAssembly = (p.assembly || 0) - deduction;
            
            // Aktualizujemy wszystkie ID powiązane z tym kątem w bazie
            const idsToSync = imperialAngleMap[masterId];
            idsToSync.forEach(targetId => {
                updates.push(db.from('products').update({ assembly: newAssembly }).eq('id', targetId));
            });
        }

        // 3. Odejmij komponenty (1 oprawa = 1 zasilacz + klapki)
        const newComponents = {
            ps_raw: this.components.ps_raw - totalQty,
            clips_normal: this.components.clips_normal - totalQty,
            clips_pass: this.components.clips_pass - totalQty
        };
        updates.push(db.from('components').update(newComponents).eq('id', 1));

        await Promise.all(updates);
        await this.fetchData();
        hideLoading();
        showToast(`Zmontowano ${totalQty} opraw. Stany zaktualizowane.`);
    }

    renderAll() {
        // Tu znajdą się funkcje renderujące tabele Imperial i PXF
        // (Wstrzykiwanie HTML do divów z index.html)
        console.log("Dane gotowe do wyświetlenia");
    }
}

// Inicjalizacja systemu
window.inventory = new InventoryManager();
window.inventory.init();

// Funkcje pomocnicze
function showLoading() { document.getElementById('loading-screen').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loading-screen').classList.add('hidden'); }
function showToast(msg) { /* Twoja logika toastów */ }
function switchTab(id) { /* Twoja logika przełączania zakładek */ }
