const db = require('./config/db');

// Tọa độ trung tâm và bán kính TP.HCM để sinh lưới điểm quan trắc
// Kinh độ X: ~106.50 đến 106.90
// Vĩ độ Y: ~10.65 đến 10.95

async function seedLstAndForecast() {
  console.log('--- Bắt đầu khởi tạo dữ liệu chuỗi thời gian LST và kết quả dự báo mẫu ---');
  
  // 1. Kiểm tra dataset
  const dsRes = await db.query('SELECT ma_dataset FROM dataset LIMIT 1');
  if (dsRes.rows.length === 0) {
    console.log('Chưa có dataset, vui lòng chạy schema.sql trước');
    return;
  }
  const maDataset = dsRes.rows[0].ma_dataset;

  // Lấy các khu vực
  const kvRes = await db.query('SELECT ma_khu_vuc, ten_khu_vuc FROM khu_vuc');
  const khuVucList = kvRes.rows;

  // Kiểm tra nếu đã có lst_data thì bỏ qua
  const checkLst = await db.query('SELECT COUNT(*) FROM lst_data WHERE ma_dataset = $1', [maDataset]);
  const currentCount = parseInt(checkLst.rows[0].count, 10);

  if (currentCount > 0) {
    console.log(`Đã có sẵn ${currentCount} bản ghi LST_DATA.`);
  } else {
    console.log('Đang sinh dữ liệu LST chuỗi thời gian 2021-2025...');
    // Tạo lưới tọa độ các trạm quan trắc mô phỏng phủ khắp TP.HCM
    const gridPoints = [
      { name: 'Quận 1', lng: 106.698, lat: 10.776, baseLst: 35.8, baseNdvi: 0.18, baseRain: 5.0, baseHumidity: 65 },
      { name: 'TP Thủ Đức - Thảo Điền', lng: 106.735, lat: 10.803, baseLst: 34.5, baseNdvi: 0.28, baseRain: 8.0, baseHumidity: 68 },
      { name: 'TP Thủ Đức - Khu CNC', lng: 106.802, lat: 10.856, baseLst: 33.8, baseNdvi: 0.35, baseRain: 12.0, baseHumidity: 70 },
      { name: 'Quận 7 - Tân Phong', lng: 106.711, lat: 10.730, baseLst: 34.0, baseNdvi: 0.30, baseRain: 10.0, baseHumidity: 72 },
      { name: 'Bình Thạnh - Thanh Đa', lng: 106.721, lat: 10.817, baseLst: 33.2, baseNdvi: 0.42, baseRain: 15.0, baseHumidity: 75 },
      { name: 'Tân Bình - Sân Bay TSN', lng: 106.660, lat: 10.818, baseLst: 37.2, baseNdvi: 0.12, baseRain: 3.0, baseHumidity: 60 },
      { name: 'Bình Tân - KCN Tân Tạo', lng: 106.592, lat: 10.755, baseLst: 36.5, baseNdvi: 0.15, baseRain: 4.0, baseHumidity: 62 },
      { name: 'Hóc Môn - Bà Điểm', lng: 106.602, lat: 10.849, baseLst: 33.0, baseNdvi: 0.45, baseRain: 18.0, baseHumidity: 76 },
      { name: 'Củ Chi - Tân An Hội', lng: 106.510, lat: 10.970, baseLst: 32.5, baseNdvi: 0.52, baseRain: 22.0, baseHumidity: 78 },
      { name: 'Nhà Bè - Phước Kiển', lng: 106.708, lat: 10.690, baseLst: 33.1, baseNdvi: 0.38, baseRain: 16.0, baseHumidity: 77 },
      { name: 'Cần Giờ - Rừng Sác', lng: 106.880, lat: 10.450, baseLst: 29.8, baseNdvi: 0.75, baseRain: 35.0, baseHumidity: 84 },
      { name: 'Quận 5 - Chợ Lớn', lng: 106.662, lat: 10.754, baseLst: 36.8, baseNdvi: 0.14, baseRain: 4.0, baseHumidity: 61 },
      { name: 'Quận 12 - An Phú Đông', lng: 106.685, lat: 10.865, baseLst: 33.6, baseNdvi: 0.38, baseRain: 14.0, baseHumidity: 72 },
    ];

    // Tạo các mốc ngày định kỳ 16 ngày (chu kỳ Landsat) từ 2021 đến 2025
    const dates = [];
    let curDate = new Date('2021-01-01');
    const endDate = new Date('2025-12-31');
    while (curDate <= endDate) {
      dates.push(curDate.toISOString().slice(0, 10));
      curDate.setDate(curDate.getDate() + 16);
    }

    const insertValues = [];
    for (const dStr of dates) {
      const month = parseInt(dStr.slice(5, 7), 10);
      // Mùa khô TP.HCM (tháng 12 - tháng 4) LST cao hơn; mùa mưa (tháng 5 - 11) LST thấp hơn
      const seasonFactor = (month >= 2 && month <= 5) ? 2.5 : (month >= 7 && month <= 10) ? -2.0 : 0.0;
      
      for (const p of gridPoints) {
        // Nhiễu ngẫu nhiên nhẹ thực tế
        const noise = (Math.sin(month + p.lat * 10) * 1.2) + (Math.random() * 0.8 - 0.4);
        const lstVal = parseFloat((p.baseLst + seasonFactor + noise).toFixed(2));
        const ndviVal = parseFloat(Math.max(-0.1, Math.min(0.9, p.baseNdvi - seasonFactor * 0.03 + (Math.random() * 0.04 - 0.02))).toFixed(3));
        const rainVal = parseFloat(Math.max(0, p.baseRain + (seasonFactor < 0 ? 40 : 0) + (Math.random() * 15)).toFixed(1));
        const humVal = parseFloat(Math.max(40, Math.min(95, p.baseHumidity - seasonFactor * 2 + (Math.random() * 6 - 3))).toFixed(1));

        insertValues.push(`(${maDataset}, '${dStr}', ${p.lat}, ${p.lng}, ${lstVal}, ${ndviVal}, ${rainVal}, ${humVal}, 'Do_thi_va_thuc_vat')`);
      }
    }

    // Insert theo batch để tối ưu tốc độ
    const batchSize = 100;
    for (let i = 0; i < insertValues.length; i += batchSize) {
      const batch = insertValues.slice(i, i + batchSize).join(',');
      await db.query(`
        INSERT INTO lst_data (ma_dataset, thoi_gian, vi_do, kinh_do, gia_tri_lst, ndvi, luong_mua, do_am_dat, lop_phu_be_mat)
        VALUES ${batch}
        ON CONFLICT (ma_dataset, thoi_gian, kinh_do, vi_do) DO NOTHING
      `);
    }
    console.log(`Đã nạp thành công ${insertValues.length} bản ghi LST.`);
  }

  // 2. Tạo các Training Run và Metric cho 4 mô hình: ARIMA, Random Forest, XGBoost, GCN-LSTM
  const models = await db.query('SELECT ma_model, ten_model FROM model ORDER BY ma_model');
  const user = await db.query('SELECT ma_nguoi_dung FROM nguoi_dung WHERE vai_tro = \'CHUYEN_GIA\' OR vai_tro = \'ADMIN\' LIMIT 1');
  const txl = await db.query('SELECT ma_tien_xu_ly FROM tien_xu_ly LIMIT 1');

  const maUser = user.rows[0].ma_nguoi_dung;
  const maTxl = txl.rows[0].ma_tien_xu_ly;

  console.log('Đang khởi tạo lịch sử huấn luyện (Training Run) và Đánh giá (Metrics)...');
  
  const modelMetricsConfig = {
    'ARIMA': {
      params: { p: 2, d: 1, q: 2, seasonal_period: 12 },
      val: { mae: 1.62, rmse: 1.95, r2: 0.74, mape: 4.8 },
      test: { mae: 1.78, rmse: 2.12, r2: 0.71, mape: 5.2 }
    },
    'Random Forest': {
      params: { n_estimators: 150, max_depth: 12, min_samples_split: 4, random_state: 42 },
      val: { mae: 1.25, rmse: 1.54, r2: 0.83, mape: 3.6 },
      test: { mae: 1.34, rmse: 1.68, r2: 0.81, mape: 3.9 }
    },
    'XGBoost': {
      params: { n_estimators: 200, max_depth: 6, learning_rate: 0.05, subsample: 0.85 },
      val: { mae: 1.05, rmse: 1.32, r2: 0.88, mape: 3.0 },
      test: { mae: 1.14, rmse: 1.41, r2: 0.86, mape: 3.2 }
    },
    'GCN-LSTM': {
      params: { gcn_layers: 2, lstm_units: 64, window_size: 10, epochs: 80, lr: 0.001 },
      val: { mae: 0.88, rmse: 1.15, r2: 0.92, mape: 2.5 },
      test: { mae: 0.96, rmse: 1.23, r2: 0.90, mape: 2.7 }
    }
  };

  for (const m of models.rows) {
    const cfg = modelMetricsConfig[m.ten_model] || {
      params: {},
      val: { mae: 1.5, rmse: 1.8, r2: 0.75, mape: 4.5 },
      test: { mae: 1.6, rmse: 1.9, r2: 0.73, mape: 4.8 }
    };

    // Kiểm tra training_run đã tồn tại chưa
    const trCheck = await db.query(
      'SELECT ma_training FROM training_run WHERE ma_dataset = $1 AND ma_model = $2',
      [maDataset, m.ma_model]
    );

    let maTraining;
    if (trCheck.rows.length === 0) {
      const trRes = await db.query(`
        INSERT INTO training_run (ma_dataset, ma_tien_xu_ly, ma_model, ma_nguoi_dung, thoi_gian_bat_dau, thoi_gian_ket_thuc, trang_thai, tham_so)
        VALUES ($1, $2, $3, $4, NOW() - INTERVAL '2 hour', NOW() - INTERVAL '1 hour', 'HOAN_THANH', $5)
        RETURNING ma_training
      `, [maDataset, maTxl, m.ma_model, maUser, JSON.stringify(cfg.params)]);
      maTraining = trRes.rows[0].ma_training;

      // Metric kiểm định
      await db.query(`
        INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape)
        VALUES ($1, 'KIEM_DINH', $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [maTraining, cfg.val.mae, cfg.val.rmse, cfg.val.r2, cfg.val.mape]);

      // Metric kiểm tra
      await db.query(`
        INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape)
        VALUES ($1, 'KIEM_TRA', $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
      `, [maTraining, cfg.test.mae, cfg.test.rmse, cfg.test.r2, cfg.test.mape]);
    } else {
      maTraining = trCheck.rows[0].ma_training;
    }

    // 3. Tạo kết quả dự báo FORECAST_RESULT cho tương lai (2026) nếu là model GCN-LSTM hoặc XGBoost
    if (m.ten_model === 'GCN-LSTM' || m.ten_model === 'XGBoost') {
      const checkFc = await db.query('SELECT COUNT(*) FROM forecast_result WHERE ma_training = $1', [maTraining]);
      if (parseInt(checkFc.rows[0].count, 10) === 0) {
        console.log(`Sinh kết quả dự báo tương lai 2026 cho mô hình ${m.ten_model}...`);
        
        // Dự báo các tháng trong năm 2026
        const forecastDates = ['2026-01-15', '2026-03-15', '2026-05-15', '2026-07-15', '2026-09-15', '2026-11-15'];
        
        // Mạng lưới điểm dự báo không gian dày đặc hơn trong toàn TP.HCM
        const forecastGrid = [
          { khuVuc: 'Quận 1', lng: 106.698, lat: 10.776, base: 36.5 },
          { khuVuc: 'Quận 1', lng: 106.705, lat: 10.785, base: 36.2 },
          { khuVuc: 'Thành phố Thủ Đức', lng: 106.735, lat: 10.803, base: 35.1 },
          { khuVuc: 'Thành phố Thủ Đức', lng: 106.780, lat: 10.840, base: 34.6 },
          { khuVuc: 'Thành phố Thủ Đức', lng: 106.820, lat: 10.870, base: 34.0 },
          { khuVuc: 'Quận 7', lng: 106.711, lat: 10.730, base: 34.8 },
          { khuVuc: 'Quận 7', lng: 106.740, lat: 10.720, base: 34.2 },
          { khuVuc: 'Quận Bình Thạnh', lng: 106.700, lat: 10.800, base: 35.6 },
          { khuVuc: 'Quận Bình Thạnh', lng: 106.725, lat: 10.825, base: 33.7 },
          { khuVuc: 'Huyện Cần Giờ', lng: 106.860, lat: 10.500, base: 30.5 },
          { khuVuc: 'Huyện Cần Giờ', lng: 106.920, lat: 10.420, base: 29.8 },
          { khuVuc: 'Thành phố Hồ Chí Minh', lng: 106.660, lat: 10.818, base: 37.8 }, // TSN
          { khuVuc: 'Thành phố Hồ Chí Minh', lng: 106.592, lat: 10.755, base: 36.9 }, // Tân Tạo
          { khuVuc: 'Thành phố Hồ Chí Minh', lng: 106.510, lat: 10.970, base: 32.8 }, // Củ Chi
        ];

        for (const fDate of forecastDates) {
          const month = parseInt(fDate.slice(5, 7), 10);
          const season = (month >= 3 && month <= 5) ? 2.8 : (month >= 7 && month <= 10) ? -2.2 : 0.0;
          
          for (const fg of forecastGrid) {
            // Tìm id khu vực tương ứng
            const kvMatch = khuVucList.find(k => k.ten_khu_vuc === fg.khuVuc) || khuVucList[0];
            const lstPredicted = parseFloat((fg.base + season + (m.ten_model === 'GCN-LSTM' ? 0.2 : -0.1) + (Math.random() * 0.6 - 0.3)).toFixed(2));

            await db.query(`
              INSERT INTO forecast_result (ma_training, ma_khu_vuc, thoi_gian_du_bao, vi_do, kinh_do, gia_tri_lst_du_bao)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT DO NOTHING
            `, [maTraining, kvMatch.ma_khu_vuc, fDate, fg.lat, fg.lng, lstPredicted]);
          }

          // Tạo MAP_LAYER tương ứng
          await db.query(`
            INSERT INTO map_layer (ma_training, ma_khu_vuc, ten_layer, thoi_gian, duong_dan_du_lieu, loai_du_lieu, mo_ta)
            VALUES ($1, $2, $3, $4, $5, 'GeoJSON', $6)
          `, [
            maTraining,
            khuVucList[0].ma_khu_vuc,
            `Bản đồ LST dự báo ${fDate} (${m.ten_model})`,
            fDate,
            `/api/layers/raster/${maTraining}/${fDate}`,
            `Lớp bản đồ phân bố nhiệt độ bề mặt đất LST dự báo bằng thuật toán ${m.ten_model}`
          ]);
        }
      }
    }
  }

  console.log('--- Hoàn tất khởi tạo dữ liệu mẫu thành công! ---');
}

if (require.main === module) {
  seedLstAndForecast()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Lỗi khởi tạo dữ liệu:', err);
      process.exit(1);
    });
}

module.exports = seedLstAndForecast;
