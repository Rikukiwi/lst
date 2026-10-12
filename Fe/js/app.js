// =====================================================================
// FRONTEND LOGIC FOR WEBGIS AI LST HCM
// =====================================================================

const API_BASE = 'http://localhost:5000/api';

let map;
let boundaryLayerGroup;
let stationLayerGroup;
let isothermLayerGroup;

let regionsData = [];
let forecastDates = [];
let historicalDates = [];
let currentMode = 'forecast'; // 'forecast' | 'historical'
let playInterval = null;

// Thang màu nhiệt độ LST
function getLstColor(temp) {
  if (temp < 28) return '#3b82f6'; // Xanh dương mát
  if (temp < 31) return '#06b6d4'; // Cyan
  if (temp < 33) return '#10b981'; // Xanh lá
  if (temp < 35) return '#f59e0b'; // Vàng cam
  if (temp < 37) return '#f97316'; // Cam đậm
  return '#ef4444'; // Đỏ nhiệt độ cao
}

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initMap();
  loadInitialData();
  setupEventListeners();
});

// 1. Quản lý Tabs chuyển đổi giao diện
function initTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      if (targetId === 'tab-map' && map) {
        setTimeout(() => map.invalidateSize(), 200);
      }
    });
  });
}

// 2. Khởi tạo Bản đồ WebGIS Leaflet
function initMap() {
  // Tọa độ trung tâm TP.HCM: [10.776, 106.700]
  map = L.map('map', {
    center: [10.776, 106.700],
    zoom: 11,
    minZoom: 9,
    maxZoom: 18,
    zoomControl: false
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Basemap tối màu (CartoDB Dark Matter / OSM)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  boundaryLayerGroup = L.layerGroup().addTo(map);
  stationLayerGroup = L.layerGroup().addTo(map);
  isothermLayerGroup = L.layerGroup().addTo(map);
}

// 3. Nạp dữ liệu ban đầu
async function loadInitialData() {
  try {
    // A. Thống kê Dashboard
    const statsRes = await fetch(`${API_BASE}/dashboard/stats`);
    const stats = await statsRes.json();
    if (stats.temperatureOverview) {
      document.getElementById('stat-max').innerText = `${stats.temperatureOverview.max}°C`;
      document.getElementById('stat-min').innerText = `${stats.temperatureOverview.min}°C`;
      document.getElementById('stat-avg').innerText = `${stats.temperatureOverview.avg}°C`;
    }

    // B. Khu vực hành chính ranh giới
    const kvRes = await fetch(`${API_BASE}/khu-vuc`);
    regionsData = await kvRes.json();
    populateRegionSelect(regionsData);
    renderBoundaryLayers(regionsData);

    // C. Mốc thời gian
    const fcDatesRes = await fetch(`${API_BASE}/forecast/dates`);
    forecastDates = await fcDatesRes.json();

    const hisDatesRes = await fetch(`${API_BASE}/lst-data/dates`);
    historicalDates = await hisDatesRes.json();

    updateDateSelector();

    // D. Nạp các tab khác
    loadModelComparison();
    loadTrainingRuns();
    loadDatasetsAndPreprocessing();

    // E. Hiển thị dữ liệu điểm trên bản đồ
    await refreshMapData();

  } catch (err) {
    console.error('Lỗi khi nạp dữ liệu:', err);
  }
}

// Cập nhật Selectbox Khu vực
function populateRegionSelect(regions) {
  const sel = document.getElementById('select-region');
  sel.innerHTML = '<option value="all">Toàn bộ TP. Hồ Chí Minh</option>';
  regions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.ma_khu_vuc;
    opt.innerText = `${r.ten_khu_vuc} (${r.loai_khu_vuc})`;
    sel.appendChild(opt);
  });
}

// Vẽ Ranh giới Hành chính (PostGIS GeoJSON)
function renderBoundaryLayers(regions) {
  boundaryLayerGroup.clearLayers();
  regions.forEach(r => {
    if (r.geojson) {
      const geoLayer = L.geoJSON(r.geojson, {
        style: {
          color: '#38bdf8',
          weight: r.ma_khu_vuc_cha ? 1.5 : 2.5,
          opacity: 0.7,
          fillColor: '#0284c7',
          fillOpacity: 0.08,
          dashArray: r.ma_khu_vuc_cha ? '4, 4' : null
        }
      });

      geoLayer.bindTooltip(`<strong>${r.ten_khu_vuc}</strong><br/>${r.mo_ta || ''}`, { sticky: true });
      geoLayer.on('click', () => {
        displayPointDetails({
          name: r.ten_khu_vuc,
          type: r.loai_khu_vuc,
          desc: r.mo_ta
        });
      });

      boundaryLayerGroup.addLayer(geoLayer);
    }
  });
}

// Cập nhật bộ chọn ngày & thanh trượt
function updateDateSelector() {
  const dates = currentMode === 'forecast' ? forecastDates : historicalDates;
  const selDate = document.getElementById('select-date');
  const slider = document.getElementById('time-slider');
  
  selDate.innerHTML = '';
  dates.forEach((d, idx) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.innerText = d;
    selDate.appendChild(opt);
  });

  if (dates.length > 0) {
    slider.max = dates.length - 1;
    slider.value = 0;
    selDate.value = dates[0];
    document.getElementById('slider-date-label').innerText = dates[0];
    document.getElementById('overlay-date-text').innerText = dates[0];
  }
}

// Nạp và vẽ lại dữ liệu LST trên bản đồ
async function refreshMapData() {
  const dates = currentMode === 'forecast' ? forecastDates : historicalDates;
  const slider = document.getElementById('time-slider');
  const curDate = dates[slider.value] || dates[0];

  if (!curDate) return;

  document.getElementById('slider-date-label').innerText = curDate;
  document.getElementById('overlay-date-text').innerText = `${curDate} [${currentMode.toUpperCase()}]`;
  document.getElementById('select-date').value = curDate;

  stationLayerGroup.clearLayers();
  isothermLayerGroup.clearLayers();

  const selectedModel = document.getElementById('select-model-filter').value;
  const selectedRegion = document.getElementById('select-region').value;

  try {
    let url = currentMode === 'forecast' 
      ? `${API_BASE}/forecast?date=${curDate}` 
      : `${API_BASE}/lst-data?date=${curDate}&limit=100`;

    if (selectedRegion !== 'all' && currentMode === 'forecast') {
      url += `&ma_khu_vuc=${selectedRegion}`;
    }

    const res = await fetch(url);
    const points = await res.json();

    const filtered = points.filter(p => {
      if (currentMode === 'forecast' && selectedModel !== 'all') {
        return p.ten_model === selectedModel;
      }
      return true;
    });

    let maxT = -999;
    let minT = 999;
    let sumT = 0;

    filtered.forEach(p => {
      const temp = currentMode === 'forecast' ? p.gia_tri_lst_du_bao : p.gia_tri_lst;
      if (temp != null) {
        if (temp > maxT) maxT = temp;
        if (temp < minT) minT = temp;
        sumT += temp;

        const color = getLstColor(temp);

        // Vòng tròn trạm nhiệt độ LST
        const circle = L.circleMarker([p.vi_do, p.kinh_do], {
          radius: 12,
          fillColor: color,
          color: '#fff',
          weight: 2,
          opacity: 0.9,
          fillOpacity: 0.85
        });

        // Vòng phát sáng gradient (Isotherm halo)
        const halo = L.circle([p.vi_do, p.kinh_do], {
          radius: 1800,
          color: color,
          weight: 0,
          fillColor: color,
          fillOpacity: 0.22
        });
        isothermLayerGroup.addLayer(halo);

        // Popup chi tiết
        const popupContent = `
          <div class="popup-title">${p.ten_khu_vuc || 'Điểm quan trắc'}</div>
          <div class="popup-data-grid">
            <div class="popup-data-item"><span>LST:</span> <strong>${temp}°C</strong></div>
            <div class="popup-data-item"><span>Thời gian:</span> <strong>${curDate}</strong></div>
            ${p.ten_model ? `<div class="popup-data-item"><span>Mô hình:</span> <strong>${p.ten_model}</strong></div>` : ''}
            ${p.ndvi != null ? `<div class="popup-data-item"><span>NDVI:</span> <strong>${p.ndvi}</strong></div>` : ''}
            ${p.luong_mua != null ? `<div class="popup-data-item"><span>Mưa:</span> <strong>${p.luong_mua} mm</strong></div>` : ''}
            ${p.do_am_dat != null ? `<div class="popup-data-item"><span>Độ ẩm:</span> <strong>${p.do_am_dat}%</strong></div>` : ''}
          </div>
        `;

        circle.bindPopup(popupContent);
        circle.on('click', () => {
          displayPointDetails({
            name: p.ten_khu_vuc || 'Tọa độ khảo sát',
            temp: temp,
            date: curDate,
            lat: p.vi_do,
            lng: p.kinh_do,
            model: p.ten_model,
            ndvi: p.ndvi,
            rain: p.luong_mua,
            humidity: p.do_am_dat
          });
        });

        stationLayerGroup.addLayer(circle);
      }
    });

    if (filtered.length > 0) {
      document.getElementById('stat-max').innerText = `${maxT.toFixed(1)}°C`;
      document.getElementById('stat-min').innerText = `${minT.toFixed(1)}°C`;
      document.getElementById('stat-avg').innerText = `${(sumT / filtered.length).toFixed(1)}°C`;
    }

  } catch (err) {
    console.error('Lỗi nạp điểm bản đồ:', err);
  }
}

// Hiển thị chi tiết vị trí ở Sidebar
function displayPointDetails(info) {
  const container = document.getElementById('point-info-content');
  container.innerHTML = `
    <div style="margin-bottom: 8px;">
      <strong style="color:#fff; font-size: 0.95rem;">${info.name}</strong>
      ${info.type ? `<span style="color:var(--text-secondary); font-size:0.75rem;"> (${info.type})</span>` : ''}
    </div>
    ${info.temp != null ? `
      <div style="font-size: 1.4rem; font-weight: 700; color:${getLstColor(info.temp)}; margin: 6px 0;">
        ${info.temp} °C
      </div>
    ` : ''}
    <div style="display:flex; flex-direction:column; gap:4px; font-size:0.8rem; color:var(--text-secondary);">
      ${info.date ? `<div><i class="fa-regular fa-calendar"></i> Thời điểm: <span style="color:#fff;">${info.date}</span></div>` : ''}
      ${info.model ? `<div><i class="fa-solid fa-microchip"></i> Thuật toán AI: <span style="color:var(--accent-cyan);">${info.model}</span></div>` : ''}
      ${info.lat ? `<div><i class="fa-solid fa-location-dot"></i> Tọa độ: ${info.lat.toFixed(4)}, ${info.lng.toFixed(4)}</div>` : ''}
      ${info.ndvi != null ? `<div><i class="fa-solid fa-leaf"></i> Chỉ số thực vật NDVI: <span style="color:#4ade80;">${info.ndvi}</span></div>` : ''}
      ${info.rain != null ? `<div><i class="fa-solid fa-cloud-rain"></i> Lượng mưa tích lũy: ${info.rain} mm</div>` : ''}
      ${info.humidity != null ? `<div><i class="fa-solid fa-droplet"></i> Độ ẩm lớp đất mặt: ${info.humidity}%</div>` : ''}
      ${info.desc ? `<div style="margin-top:6px; font-style:italic;">${info.desc}</div>` : ''}
    </div>
  `;
}

// 4. TAB MÔ HÌNH: Nạp bảng so sánh chỉ số Model Metrics
async function loadModelComparison() {
  try {
    const res = await fetch(`${API_BASE}/model-comparison`);
    const data = await res.json();
    const tbody = document.getElementById('metrics-tbody');
    tbody.innerHTML = '';

    data.forEach((m, idx) => {
      const tr = document.createElement('tr');
      const rankBadge = idx === 0 
        ? '<span class="badge-metric badge-top1"><i class="fa-solid fa-crown"></i> Hạng 1 (Best)</span>'
        : idx === 1 
        ? '<span class="badge-metric badge-top2">Hạng 2</span>'
        : `<span class="badge-metric badge-top3">Hạng ${idx + 1}</span>`;

      tr.innerHTML = `
        <td>${rankBadge}</td>
        <td><strong>${m.ten_model}</strong></td>
        <td><span style="font-size:0.75rem; color:var(--text-secondary);">${idx === 0 ? 'Học sâu (Deep Learning)' : idx === 1 || idx === 2 ? 'Học máy (Machine Learning)' : 'Thống kê (Statistical)'}</span></td>
        <td><strong style="color:var(--accent-cyan);">${m.mae}°C</strong></td>
        <td><strong style="color:var(--accent-rose);">${m.rmse}°C</strong></td>
        <td><strong style="color:var(--accent-emerald);">${m.r2}</strong></td>
        <td>${m.mape}%</td>
        <td>
          <span style="font-size:0.75rem; color:${idx < 2 ? 'var(--accent-emerald)' : 'var(--text-secondary)'}">
            ${idx === 0 ? 'Tối ưu cho chuỗi không gian - thời gian' : idx === 1 ? 'Mạnh mẽ trên tập thuộc tính bảng' : 'Mô hình baseline so sánh'}
          </span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Lỗi khi nạp so sánh mô hình:', err);
  }
}

// Nạp lịch sử các lần chạy huấn luyện
async function loadTrainingRuns() {
  try {
    const res = await fetch(`${API_BASE}/training-runs`);
    const data = await res.json();
    const container = document.getElementById('training-runs-list');
    container.innerHTML = '';

    data.forEach(r => {
      const item = document.createElement('div');
      item.className = 'run-item';
      
      const testMetric = (r.metrics || []).find(m => m.tap_danh_gia === 'KIEM_TRA') || {};

      item.innerHTML = `
        <div class="run-info">
          <h5><i class="fa-solid fa-cube"></i> Lần #${r.ma_training}: ${r.ten_model}</h5>
          <p>Dataset: ${r.ten_dataset} | Người chạy: ${r.ten_dang_nhap || 'Admin'}</p>
        </div>
        <div class="run-metrics-badge">
          <div style="color:var(--accent-emerald); font-weight:600;">RMSE: ${testMetric.rmse || '--'}°C</div>
          <div style="color:var(--text-secondary);">R²: ${testMetric.r2 || '--'}</div>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    console.error('Lỗi khi nạp lịch sử huấn luyện:', err);
  }
}

// 5. TAB DATASET & TIỀN XỬ LÝ
async function loadDatasetsAndPreprocessing() {
  try {
    // A. Datasets
    const dsRes = await fetch(`${API_BASE}/datasets`);
    const datasets = await dsRes.json();
    
    const dsContainer = document.getElementById('datasets-container');
    const txlDsSelect = document.getElementById('txl-dataset');
    const trainDsSelect = document.getElementById('train-dataset');

    dsContainer.innerHTML = '';
    txlDsSelect.innerHTML = '';
    trainDsSelect.innerHTML = '';

    datasets.forEach(d => {
      const card = document.createElement('div');
      card.style.cssText = 'background:rgba(15,23,42,0.6); padding:12px; border-radius:8px; border:1px solid var(--border-color); margin-bottom:10px;';
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <h4 style="color:var(--accent-cyan); font-size:0.9rem;">${d.ten_dataset}</h4>
          <span style="font-size:0.7rem; background:rgba(6,182,212,0.2); color:var(--accent-cyan); padding:2px 6px; border-radius:4px;">${d.nguon_du_lieu}</span>
        </div>
        <p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">${d.mo_ta || ''}</p>
        <div style="font-size:0.75rem; color:var(--text-secondary); display:flex; gap:16px;">
          <span><i class="fa-regular fa-calendar"></i> ${d.thoi_gian_bat_dau} đến ${d.thoi_gian_ket_thuc}</span>
          <span><i class="fa-solid fa-chart-simple"></i> ${d.tong_so_diem} bản ghi LST</span>
        </div>
      `;
      dsContainer.appendChild(card);

      const opt1 = new Option(d.ten_dataset, d.ma_dataset);
      const opt2 = new Option(d.ten_dataset, d.ma_dataset);
      txlDsSelect.appendChild(opt1);
      trainDsSelect.appendChild(opt2);
    });

    // B. Tiền xử lý
    const txlRes = await fetch(`${API_BASE}/tien-xu-ly`);
    const txlList = await txlRes.json();
    const trainTxlSelect = document.getElementById('train-txl');
    trainTxlSelect.innerHTML = '';

    txlList.forEach(t => {
      const opt = new Option(`Cấu hình #${t.ma_tien_xu_ly} (${t.phuong_phap_chuan_hoa} - Train đến ${t.ngay_ket_thuc_train})`, t.ma_tien_xu_ly);
      trainTxlSelect.appendChild(opt);
    });

    // C. Preview LST Data
    const lstRes = await fetch(`${API_BASE}/lst-data?limit=15`);
    const lstData = await lstRes.json();
    const lstTbody = document.getElementById('lst-preview-tbody');
    lstTbody.innerHTML = '';

    lstData.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.ma_lst}</td>
        <td>${r.thoi_gian ? r.thoi_gian.slice(0, 10) : ''}</td>
        <td>${r.kinh_do}</td>
        <td>${r.vi_do}</td>
        <td><strong style="color:${getLstColor(r.gia_tri_lst)}">${r.gia_tri_lst}°C</strong></td>
        <td>${r.ndvi != null ? r.ndvi : '--'}</td>
        <td>${r.luong_mua != null ? r.luong_mua : '--'}</td>
        <td>${r.do_am_dat != null ? r.do_am_dat : '--'}</td>
        <td>${r.lop_phu_be_mat || 'Đô thị'}</td>
      `;
      lstTbody.appendChild(tr);
    });

    // D. Danh mục Model cho Form Train
    const mRes = await fetch(`${API_BASE}/models`);
    const models = await mRes.json();
    const trainModelSelect = document.getElementById('train-model');
    trainModelSelect.innerHTML = '';

    models.forEach(m => {
      trainModelSelect.appendChild(new Option(`${m.ten_model} (${m.loai_model})`, m.ma_model));
    });

    updateHyperparamFields(models[0]?.ten_model || 'GCN-LSTM');

  } catch (err) {
    console.error('Lỗi khi nạp dataset/tiền xử lý:', err);
  }
}

// Cập nhật trường siêu tham số theo loại mô hình
function updateHyperparamFields(modelName) {
  const box = document.getElementById('hyperparams-fields');
  box.innerHTML = '';

  if (modelName.includes('LSTM')) {
    box.innerHTML = `
      <div class="form-group col-6">
        <label>Epochs:</label>
        <input type="number" id="hp-epochs" class="custom-input" value="100" />
      </div>
      <div class="form-group col-6">
        <label>Learning Rate:</label>
        <input type="number" step="0.0001" id="hp-lr" class="custom-input" value="0.001" />
      </div>
    `;
  } else if (modelName.includes('XGBoost') || modelName.includes('Forest')) {
    box.innerHTML = `
      <div class="form-group col-6">
        <label>Số cây (n_estimators):</label>
        <input type="number" id="hp-trees" class="custom-input" value="200" />
      </div>
      <div class="form-group col-6">
        <label>Độ sâu tối đa (max_depth):</label>
        <input type="number" id="hp-depth" class="custom-input" value="8" />
      </div>
    `;
  } else {
    box.innerHTML = `
      <div class="form-group col-6">
        <label>Order (p, d, q):</label>
        <input type="text" id="hp-order" class="custom-input" value="2, 1, 2" />
      </div>
    `;
  }
}

// 6. Gán các Event Listeners
function setupEventListeners() {
  // Thay đổi Chế độ (Dự báo vs Thực tế)
  document.getElementById('select-mode').addEventListener('change', (e) => {
    currentMode = e.target.value;
    updateDateSelector();
    refreshMapData();
  });

  // Thay đổi mốc thời gian qua Select
  document.getElementById('select-date').addEventListener('change', (e) => {
    const dates = currentMode === 'forecast' ? forecastDates : historicalDates;
    const idx = dates.indexOf(e.target.value);
    if (idx !== -1) {
      document.getElementById('time-slider').value = idx;
      refreshMapData();
    }
  });

  // Kéo thanh trượt thời gian
  document.getElementById('time-slider').addEventListener('input', () => {
    refreshMapData();
  });

  // Tự động chạy chuỗi thời gian (Playback)
  const playBtn = document.getElementById('btn-play-pause');
  playBtn.addEventListener('click', () => {
    if (playInterval) {
      clearInterval(playInterval);
      playInterval = null;
      playBtn.innerHTML = '<i class="fa-solid fa-play"></i> Tự động chạy';
      playBtn.classList.remove('btn-primary');
      playBtn.classList.add('btn-outline');
    } else {
      playBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng lại';
      playBtn.classList.remove('btn-outline');
      playBtn.classList.add('btn-primary');
      
      const slider = document.getElementById('time-slider');
      playInterval = setInterval(() => {
        let nextVal = parseInt(slider.value, 10) + 1;
        if (nextVal > parseInt(slider.max, 10)) {
          nextVal = 0;
        }
        slider.value = nextVal;
        refreshMapData();
      }, 1600);
    }
  });

  // Bộ lọc mô hình & khu vực
  document.getElementById('select-model-filter').addEventListener('change', refreshMapData);
  document.getElementById('select-region').addEventListener('change', (e) => {
    const regionId = e.target.value;
    if (regionId !== 'all') {
      const found = regionsData.find(r => r.ma_khu_vuc == regionId);
      if (found && found.geojson) {
        const bounds = L.geoJSON(found.geojson).getBounds();
        map.fitBounds(bounds, { padding: [20, 20] });
      }
    } else {
      map.setView([10.776, 106.700], 11);
    }
    refreshMapData();
  });

  // Layer Toggles
  document.getElementById('chk-boundary').addEventListener('change', (e) => {
    if (e.target.checked) map.addLayer(boundaryLayerGroup);
    else map.removeLayer(boundaryLayerGroup);
  });

  document.getElementById('chk-stations').addEventListener('change', (e) => {
    if (e.target.checked) map.addLayer(stationLayerGroup);
    else map.removeLayer(stationLayerGroup);
  });

  document.getElementById('chk-heat').addEventListener('change', (e) => {
    if (e.target.checked) map.addLayer(isothermLayerGroup);
    else map.removeLayer(isothermLayerGroup);
  });

  // Đổi Model ở Tab Train -> Đổi fields siêu tham số
  document.getElementById('train-model').addEventListener('change', (e) => {
    const txt = e.target.options[e.target.selectedIndex].text;
    updateHyperparamFields(txt);
  });

  // Submit Form Tiền xử lý
  document.getElementById('form-preprocessing').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      ma_dataset: document.getElementById('txl-dataset').value,
      cach_xu_ly_thieu: document.getElementById('txl-missing').value,
      cach_xu_ly_nhieu: document.getElementById('txl-noise').value,
      phuong_phap_chuan_hoa: document.getElementById('txl-norm').value,
      ngay_ket_thuc_train: document.getElementById('txl-train-end').value,
      ngay_ket_thuc_val: document.getElementById('txl-val-end').value,
    };

    try {
      const res = await fetch(`${API_BASE}/tien-xu-ly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        alert('Đã lưu cấu hình tiền xử lý thành công!');
        loadDatasetsAndPreprocessing();
      }
    } catch (err) {
      alert('Lỗi: ' + err.message);
    }
  });

  // Submit Form Huấn luyện Mô hình
  document.getElementById('form-train').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-submit-train');
    const consoleBox = document.getElementById('train-console');

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang huấn luyện mô hình...';

    consoleBox.innerHTML += `<p class="log-warn">[Khởi chạy] Đang tiền xử lý dữ liệu và khởi động pipeline AI...</p>`;

    const payload = {
      ma_model: document.getElementById('train-model').value,
      ma_dataset: document.getElementById('train-dataset').value,
      ma_tien_xu_ly: document.getElementById('train-txl').value,
      tham_so: {
        epochs: document.getElementById('hp-epochs')?.value || 100,
        lr: document.getElementById('hp-lr')?.value || 0.001,
        trees: document.getElementById('hp-trees')?.value || 150
      }
    };

    try {
      const res = await fetch(`${API_BASE}/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        consoleBox.innerHTML += `<p class="log-success">[Thành công] ${data.message}</p>`;
        consoleBox.innerHTML += `<p class="log-info">[Đánh giá Kiểm tra (Test)] MAE: ${data.testMetrics.mae}°C | RMSE: ${data.testMetrics.rmse}°C | R²: ${data.testMetrics.r2} | MAPE: ${data.testMetrics.mape}%</p>`;
        consoleBox.scrollTop = consoleBox.scrollHeight;

        // Cập nhật lại các bảng dữ liệu
        loadModelComparison();
        loadTrainingRuns();
      } else {
        consoleBox.innerHTML += `<p class="log-err">[Lỗi] ${data.message || data.error}</p>`;
      }
    } catch (err) {
      consoleBox.innerHTML += `<p class="log-err">[Lỗi kết nối] ${err.message}</p>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-play"></i> Bắt đầu Huấn luyện & Đánh giá';
    }
  });
}
