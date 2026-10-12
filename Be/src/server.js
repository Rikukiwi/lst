const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./config/db');
const { trainAndForecast } = require('./aiEngine');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'webgis_lst_hcm_ai_secret_key_2026';

app.use(cors());
app.use(express.json());

// ==========================================
// 1. AUTHENTICATION & USERS (NGUOI_DUNG)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const { ten_dang_nhap, mat_khau } = req.body;
  try {
    const result = await db.query(
      'SELECT ma_nguoi_dung, ten_dang_nhap, mat_khau_ma_hoa, email, vai_tro, trang_thai FROM nguoi_dung WHERE ten_dang_nhap = $1',
      [ten_dang_nhap]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không chính xác' });
    }

    const user = result.rows[0];
    if (user.trang_thai === 'KHOA') {
      return res.status(403).json({ message: 'Tài khoản của bạn đã bị khóa' });
    }

    // Kiểm tra mật khẩu (hỗ trợ pass hash và pass mẫu demo)
    const isMatch = (mat_khau === '123456' || mat_khau === 'admin') || 
                    await bcrypt.compare(mat_khau, user.mat_khau_ma_hoa).catch(() => false);

    if (!isMatch) {
      return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không chính xác' });
    }

    const token = jwt.sign(
      { ma_nguoi_dung: user.ma_nguoi_dung, vai_tro: user.vai_tro, ten_dang_nhap: user.ten_dang_nhap },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        ma_nguoi_dung: user.ma_nguoi_dung,
        ten_dang_nhap: user.ten_dang_nhap,
        email: user.email,
        vai_tro: user.vai_tro
      }
    });
  } catch (err) {
    console.error('Lỗi đăng nhập:', err);
    res.status(500).json({ message: 'Lỗi máy chủ', error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await db.query('SELECT ma_nguoi_dung, ten_dang_nhap, email, vai_tro, trang_thai FROM nguoi_dung ORDER BY ma_nguoi_dung');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. KHU VỰC HÀNH CHÍNH & RANH GIỚI (KHU_VUC)
// ==========================================
app.get('/api/khu-vuc', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT ma_khu_vuc, ten_khu_vuc, loai_khu_vuc, ma_khu_vuc_cha, mo_ta,
             ST_AsGeoJSON(ranh_gioi) as geojson
      FROM khu_vuc
      ORDER BY ma_khu_vuc
    `);
    
    // Parse GeoJSON ranh giới
    const data = result.rows.map(r => ({
      ...r,
      geojson: r.geojson ? JSON.parse(r.geojson) : null
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. QUẢN LÝ DATASET & TIỀN XỬ LÝ (DATASET, TIEN_XU_LY)
// ==========================================
app.get('/api/datasets', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT d.*, u.ten_dang_nhap as nguoi_tai,
             (SELECT COUNT(*) FROM lst_data WHERE ma_dataset = d.ma_dataset) as tong_so_diem
      FROM dataset d
      LEFT JOIN nguoi_dung u ON d.ma_nguoi_dung = u.ma_nguoi_dung
      ORDER BY d.ma_dataset DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tien-xu-ly', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT t.*, d.ten_dataset 
      FROM tien_xu_ly t
      JOIN dataset d ON t.ma_dataset = d.ma_dataset
      ORDER BY t.ma_tien_xu_ly DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tien-xu-ly', async (req, res) => {
  const { ma_dataset, cach_xu_ly_thieu, cach_xu_ly_nhieu, phuong_phap_chuan_hoa, ngay_ket_thuc_train, ngay_ket_thuc_val } = req.body;
  try {
    const result = await db.query(`
      INSERT INTO tien_xu_ly (ma_dataset, cach_xu_ly_thieu, cach_xu_ly_nhieu, phuong_phap_chuan_hoa, ngay_ket_thuc_train, ngay_ket_thuc_val)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [ma_dataset, cach_xu_ly_thieu, cach_xu_ly_nhieu, phuong_phap_chuan_hoa, ngay_ket_thuc_train, ngay_ket_thuc_val]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. DỮ LIỆU LST ĐẦU VÀO (LST_DATA)
// ==========================================
app.get('/api/lst-data', async (req, res) => {
  const { ma_dataset, date, limit = 500 } = req.query;
  try {
    let queryStr = `
      SELECT ma_lst, thoi_gian, vi_do, kinh_do, gia_tri_lst, ndvi, luong_mua, do_am_dat, lop_phu_be_mat
      FROM lst_data
      WHERE 1=1
    `;
    const params = [];
    if (ma_dataset) {
      params.push(ma_dataset);
      queryStr += ` AND ma_dataset = $${params.length}`;
    }
    if (date) {
      params.push(date);
      queryStr += ` AND thoi_gian = $${params.length}`;
    }
    queryStr += ` ORDER BY thoi_gian DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const result = await db.query(queryStr, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lấy danh sách các mốc thời gian có dữ liệu LST
app.get('/api/lst-data/dates', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT to_char(thoi_gian, 'YYYY-MM-DD') as date
      FROM lst_data
      ORDER BY date ASC
    `);
    res.json(result.rows.map(r => r.date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. DANH MỤC MÔ HÌNH AI (MODEL)
// ==========================================
app.get('/api/models', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM model ORDER BY ma_model');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. HUẤN LUYỆN MÔ HÌNH (TRAINING_RUN, METRICS)
// ==========================================
app.get('/api/training-runs', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT tr.*, m.ten_model, m.loai_model, d.ten_dataset, u.ten_dang_nhap,
             (SELECT json_agg(mm.*) FROM model_metric mm WHERE mm.ma_training = tr.ma_training) as metrics
      FROM training_run tr
      JOIN model m ON tr.ma_model = m.ma_model
      JOIN dataset d ON tr.ma_dataset = d.ma_dataset
      LEFT JOIN nguoi_dung u ON tr.ma_nguoi_dung = u.ma_nguoi_dung
      ORDER BY tr.ma_training DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bảng so sánh mô hình (View v_so_sanh_model)
app.get('/api/model-comparison', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM v_so_sanh_model');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kích hoạt Huấn luyện Mô hình mới (Trigger Training)
app.post('/api/train', async (req, res) => {
  const { ma_model, ma_dataset, ma_tien_xu_ly, ma_nguoi_dung = 1, tham_so = {} } = req.body;
  try {
    // 1. Lấy thông tin model
    const mRes = await db.query('SELECT ten_model FROM model WHERE ma_model = $1', [ma_model]);
    if (mRes.rows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy mô hình' });
    }
    const tenModel = mRes.rows[0].ten_model;

    // 2. Lấy dữ liệu LST của dataset
    const lstRes = await db.query(`
      SELECT thoi_gian, gia_tri_lst, ndvi, luong_mua, do_am_dat, kinh_do, vi_do 
      FROM lst_data 
      WHERE ma_dataset = $1 AND gia_tri_lst IS NOT NULL 
      ORDER BY thoi_gian ASC
    `, [ma_dataset]);

    if (lstRes.rows.length === 0) {
      return res.status(400).json({ message: 'Dataset chưa có dữ liệu LST để huấn luyện' });
    }

    // 3. Thực thi huấn luyện qua AI Engine
    const trainResult = trainAndForecast(tenModel, lstRes.rows, tham_so);

    // 4. Lưu training run
    const trInsert = await db.query(`
      INSERT INTO training_run (ma_dataset, ma_tien_xu_ly, ma_model, ma_nguoi_dung, thoi_gian_bat_dau, thoi_gian_ket_thuc, trang_thai, tham_so)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute', NOW(), 'HOAN_THANH', $5)
      RETURNING ma_training
    `, [ma_dataset, ma_tien_xu_ly, ma_model, ma_nguoi_dung, JSON.stringify(tham_so)]);

    const maTraining = trInsert.rows[0].ma_training;

    // 5. Lưu Metric kiểm định & kiểm tra
    await db.query(`
      INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape)
      VALUES ($1, 'KIEM_DINH', $2, $3, $4, $5)
    `, [maTraining, trainResult.valMetrics.mae, trainResult.valMetrics.rmse, trainResult.valMetrics.r2, trainResult.valMetrics.mape]);

    await db.query(`
      INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape)
      VALUES ($1, 'KIEM_TRA', $2, $3, $4, $5)
    `, [maTraining, trainResult.testMetrics.mae, trainResult.testMetrics.rmse, trainResult.testMetrics.r2, trainResult.testMetrics.mape]);

    res.json({
      message: 'Huấn luyện mô hình thành công!',
      ma_training: maTraining,
      model: tenModel,
      valMetrics: trainResult.valMetrics,
      testMetrics: trainResult.testMetrics,
      details: trainResult
    });
  } catch (err) {
    console.error('Lỗi huấn luyện:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. KẾT QUẢ DỰ BÁO LST & WEBGIS (FORECAST_RESULT, MAP_LAYER)
// ==========================================
app.get('/api/forecast', async (req, res) => {
  const { date, ma_khu_vuc, ma_training } = req.query;
  try {
    let queryStr = `
      SELECT f.ma_du_bao, to_char(f.thoi_gian_du_bao, 'YYYY-MM-DD') as thoi_gian_du_bao,
             f.vi_do, f.kinh_do, f.gia_tri_lst_du_bao, kv.ten_khu_vuc, m.ten_model, f.ma_training
      FROM forecast_result f
      JOIN khu_vuc kv ON f.ma_khu_vuc = kv.ma_khu_vuc
      JOIN training_run tr ON f.ma_training = tr.ma_training
      JOIN model m ON tr.ma_model = m.ma_model
      WHERE 1=1
    `;
    const params = [];
    if (date) {
      params.push(date);
      queryStr += ` AND f.thoi_gian_du_bao = $${params.length}`;
    }
    if (ma_khu_vuc) {
      params.push(ma_khu_vuc);
      queryStr += ` AND f.ma_khu_vuc = $${params.length}`;
    }
    if (ma_training) {
      params.push(ma_training);
      queryStr += ` AND f.ma_training = $${params.length}`;
    }

    queryStr += ' ORDER BY f.thoi_gian_du_bao ASC, f.ma_du_bao ASC';

    const result = await db.query(queryStr, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Danh sách các mốc thời gian có kết quả dự báo
app.get('/api/forecast/dates', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT to_char(thoi_gian_du_bao, 'YYYY-MM-DD') as date
      FROM forecast_result
      ORDER BY date ASC
    `);
    res.json(result.rows.map(r => r.date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Các lớp bản đồ đã tạo (MAP_LAYER)
app.get('/api/map-layers', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT ml.*, kv.ten_khu_vuc, m.ten_model
      FROM map_layer ml
      JOIN khu_vuc kv ON ml.ma_khu_vuc = kv.ma_khu_vuc
      JOIN training_run tr ON ml.ma_training = tr.ma_training
      JOIN model m ON tr.ma_model = m.ma_model
      ORDER BY ml.ma_layer DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint thống kê tổng quan hệ thống Dashboard
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [cDataset, cLst, cModel, cRuns, cForecast, cKv] = await Promise.all([
      db.query('SELECT COUNT(*) FROM dataset'),
      db.query('SELECT COUNT(*) FROM lst_data'),
      db.query('SELECT COUNT(*) FROM model'),
      db.query('SELECT COUNT(*) FROM training_run WHERE trang_thai = \'HOAN_THANH\''),
      db.query('SELECT COUNT(*) FROM forecast_result'),
      db.query('SELECT COUNT(*) FROM khu_vuc')
    ]);

    // Thống kê nhiệt độ cao nhất, thấp nhất gần nhất
    const tempStats = await db.query(`
      SELECT MIN(gia_tri_lst) as min_temp, MAX(gia_tri_lst) as max_temp, AVG(gia_tri_lst) as avg_temp
      FROM lst_data WHERE gia_tri_lst IS NOT NULL
    `);

    res.json({
      totalDatasets: parseInt(cDataset.rows[0].count, 10),
      totalLstRecords: parseInt(cLst.rows[0].count, 10),
      totalModels: parseInt(cModel.rows[0].count, 10),
      totalRuns: parseInt(cRuns.rows[0].count, 10),
      totalForecastPoints: parseInt(cForecast.rows[0].count, 10),
      totalRegions: parseInt(cKv.rows[0].count, 10),
      temperatureOverview: {
        min: parseFloat(Number(tempStats.rows[0].min_temp || 28).toFixed(1)),
        max: parseFloat(Number(tempStats.rows[0].max_temp || 39).toFixed(1)),
        avg: parseFloat(Number(tempStats.rows[0].avg_temp || 33.5).toFixed(1))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Khởi chạy server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 WebGIS AI LST HCM Backend running at http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
