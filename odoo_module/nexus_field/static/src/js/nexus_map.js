/** @odoo-module **/
import { registry } from '@web/core/registry';
import { Component, onMounted, onWillUnmount, useRef } from '@odoo/owl';
import { useService } from '@web/core/utils/hooks';

// ── Leaflet desde CDN (sin instalar nada en Odoo) ──
function loadLeaflet() {
    return new Promise((resolve) => {
        if (window.L) return resolve();
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(css);
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.onload = resolve;
        document.head.appendChild(script);
    });
}

// ── Colores por estado ──
const ESTADO_COLOR = {
    en_cliente: '#22c55e',   // verde
    en_ruta:    '#3b82f6',   // azul
    sin_senal:  '#9ca3af',   // gris
};

class NexusMapComponent extends Component {
    static template = 'nexus_field.MapTemplate';

    setup() {
        this.rpc = useService('rpc');
        this.mapRef = useRef('mapContainer');
        this.map = null;
        this.markers = {};
        this.interval = null;
        this.gatewayUrl = null;
        this.token = null;

        onMounted(async () => {
            await this._loadConfig();
            await loadLeaflet();
            this._initMap();
            await this._loadLocations();
            this.interval = setInterval(() => this._loadLocations(), (this.refreshInterval || 30) * 1000);
        });

        onWillUnmount(() => {
            if (this.interval) clearInterval(this.interval);
            if (this.map) this.map.remove();
        });
    }

    async _loadConfig() {
        const configs = await this.rpc('/web/dataset/call_kw', {
            model: 'nexus.config',
            method: 'search_read',
            args: [[]],
            kwargs: { fields: ['gateway_url', 'supervisor_token', 'refresh_interval'], limit: 1 }
        });
        if (configs && configs.length) {
            this.gatewayUrl = configs[0].gateway_url.replace(/\/$/, '');
            this.token = configs[0].supervisor_token;
            this.refreshInterval = configs[0].refresh_interval || 30;
        }
    }

    _initMap() {
        const el = this.mapRef.el;
        if (!el || !window.L) return;

        this.map = L.map(el).setView([10.4880, -66.8792], 7); // Venezuela

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
    }

    async _loadLocations() {
        if (!this.gatewayUrl || !this.token) return;

        try {
            const res = await fetch(`${this.gatewayUrl}/api/v1/supervisor/team/locations`, {
                headers: { Authorization: `Bearer ${this.token}` }
            });
            if (!res.ok) return;
            const data = await res.json();

            this._updateStats(data);
            this._updateMarkers(data.vendedores || []);
        } catch (e) {
            console.warn('[NEXUS] Error cargando ubicaciones:', e.message);
        }
    }

    _updateStats(data) {
        const el = document.getElementById('nexus_stats');
        if (!el) return;
        el.innerHTML = `
            <span class="nexus-stat nexus-stat-total">👥 ${data.total} vendedores</span>
            <span class="nexus-stat nexus-stat-online">🟢 ${data.con_senal} con señal</span>
            <span class="nexus-stat nexus-stat-offline">⚫ ${data.sin_senal} sin señal</span>
        `;
    }

    _updateMarkers(vendedores) {
        if (!this.map || !window.L) return;

        vendedores.forEach(v => {
            const color = ESTADO_COLOR[v.estado] || ESTADO_COLOR.sin_senal;
            const label = v.estado === 'sin_senal'
                ? `${v.nombre}<br><small>Sin señal${v.minutos_sin_reporte ? ` hace ${v.minutos_sin_reporte}min` : ''}</small>`
                : `${v.nombre}<br><small>${v.cliente_actual || 'En tránsito'}</small>`;

            const icon = L.divIcon({
                className: '',
                html: `<div style="
                    background:${color};
                    width:14px;height:14px;border-radius:50%;
                    border:2px solid white;
                    box-shadow:0 1px 4px rgba(0,0,0,0.4)">
                </div>`,
                iconSize: [14, 14],
                iconAnchor: [7, 7],
            });

            if (this.markers[v.vendedor_id]) {
                if (v.lat && v.lng) {
                    this.markers[v.vendedor_id].setLatLng([v.lat, v.lng]);
                    this.markers[v.vendedor_id].setIcon(icon);
                    this.markers[v.vendedor_id].getPopup().setContent(label);
                }
            } else if (v.lat && v.lng) {
                const marker = L.marker([v.lat, v.lng], { icon })
                    .addTo(this.map)
                    .bindPopup(label);
                this.markers[v.vendedor_id] = marker;
            }
        });
    }
}

// ── Template inline ──
NexusMapComponent.template = owl.xml`
<div class="nexus-map-wrapper" style="height:100%;display:flex;flex-direction:column;">
    <div id="nexus_stats" style="
        padding:10px 16px;
        background:#1e293b;
        color:white;
        display:flex;gap:24px;font-size:13px;align-items:center;">
        <strong style="color:#38bdf8;font-size:15px;">NEXUS Field — En vivo</strong>
        <span>Cargando...</span>
    </div>
    <div t-ref="mapContainer" style="flex:1;min-height:500px;"/>
</div>
`;

// ── Estilos ──
const style = document.createElement('style');
style.textContent = `
    .nexus-map-wrapper { height: calc(100vh - 120px); }
    .nexus-stat { font-weight: 500; }
    .nexus-stat-online { color: #86efac; }
    .nexus-stat-offline { color: #9ca3af; }
`;
document.head.appendChild(style);

registry.category('actions').add('nexus_map', NexusMapComponent);
