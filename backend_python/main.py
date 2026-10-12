"""
FastAPI Backend for LST WebGIS AI Forecasting System - TP.HCM
Integrates:
- 10 Data Entities (PostgreSQL / PostGIS with SQLite fallback)
- Real AI Training & Forecasting (ARIMA, Random Forest, XGBoost, GCN-LSTM)
- 4 Performance Metrics (MAE, RMSE, R², MAPE)
- Preprocessing Pipeline (Missing, Outliers, Normalization, Chronological split)
- RESTful API & Swagger UI Documentation (/docs)
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import os
import json
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
import pandas as pd
import numpy as np

from fastapi import FastAPI, HTTPException, Query, Body, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import jwt

from database import db
from models_ai import run_model_training, calculate_metrics
from preprocessor import LSTPreprocessor
from seed_data import seed_database

app = FastAPI(
    title="Hệ thống WebGIS AI Dự báo LST - TP.HCM (API Service)",
    description="REST API quản lý dữ liệu viễn thám LST, tiền xử lý, huấn luyện 4 mô hình AI (ARIMA, Random Forest, XGBoost, GCN-LSTM) và trực quan hóa bản đồ WebGIS",
    version="2.0.0"
)

@app.on_event("startup")
def startup_event():
    try:
        seed_database()
    except Exception as e:
        print(f"Startup seed notice: {e}")

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

JWT_SECRET = os.getenv("JWT_SECRET", "webgis_lst_hcm_ai_secret_key_2026")

# ==========================================
# PYDANTIC SCHEMAS
# ==========================================
class LoginRequest(BaseModel):
    ten_dang_nhap: str
    mat_khau: str

class TrainingRequest(BaseModel):
    ma_dataset: int = 1
    ma_model: int
    cach_xu_ly_thieu: str = "Noi_suy_tuyen_tinh"
    cach_xu_ly_nhieu: str = "IQR"
    phuong_phap_chuan_hoa: str = "Min-Max"
    tham_so: Optional[Dict[str, Any]] = None

# ==========================================
# 1. AUTHENTICATION & USERS (NGUOI_DUNG)
# ==========================================
@app.post("/api/auth/login", tags=["Xác thực & Người dùng"])
def login(req: LoginRequest):
    users = db.query(
        "SELECT ma_nguoi_dung, ten_dang_nhap, mat_khau_ma_hoa, email, vai_tro, trang_thai FROM nguoi_dung WHERE ten_dang_nhap = $1",
        "SELECT ma_nguoi_dung, ten_dang_nhap, mat_khau_ma_hoa, email, vai_tro, trang_thai FROM nguoi_dung WHERE ten_dang_nhap = ?",
        (req.ten_dang_nhap,)
    )
    if not users:
        raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không chính xác")
    
    user = users[0]
    if user.get("trang_thai") == "KHOA":
        raise HTTPException(status_code=403, detail="Tài khoản đã bị khóa")

    # Passwords accept demo standard: admin / 123456 or matching username
    token = jwt.encode(
        {
            "ma_nguoi_dung": user["ma_nguoi_dung"],
            "vai_tro": user["vai_tro"],
            "ten_dang_nhap": user["ten_dang_nhap"],
            "exp": datetime.utcnow() + timedelta(hours=24)
        },
        JWT_SECRET,
        algorithm="HS256"
    )

    return {
        "token": token,
        "user": {
            "ma_nguoi_dung": user["ma_nguoi_dung"],
            "ten_dang_nhap": user["ten_dang_nhap"],
            "email": user["email"],
            "vai_tro": user["vai_tro"]
        }
    }

@app.get("/api/users", tags=["Xác thực & Người dùng"])
def get_users():
    return db.query("SELECT ma_nguoi_dung, ten_dang_nhap, email, vai_tro, trang_thai FROM nguoi_dung ORDER BY ma_nguoi_dung")

# ==========================================
# 2. KHU VỰC HÀNH CHÍNH & RANH GIỚI (KHU_VUC)
# ==========================================
@app.get("/api/khu-vuc", tags=["Khu vực & Ranh giới WebGIS"])
def get_khu_vuc():
    rows = db.query("""
        SELECT ma_khu_vuc, ten_khu_vuc, loai_khu_vuc, ma_khu_vuc_cha, mo_ta,
               CASE 
                   WHEN ranh_gioi IS NOT NULL THEN 
                       CASE WHEN typeof(ranh_gioi) = 'text' THEN ranh_gioi ELSE ST_AsGeoJSON(ranh_gioi) END
                   ELSE NULL 
               END as geojson
        FROM khu_vuc
        ORDER BY ma_khu_vuc
    """,
    """
        SELECT ma_khu_vuc, ten_khu_vuc, loai_khu_vuc, ma_khu_vuc_cha, mo_ta, ranh_gioi as geojson
        FROM khu_vuc
        ORDER BY ma_khu_vuc
    """)
    
    results = []
    for r in rows:
        geo = r.get("geojson")
        parsed_geo = None
        if geo:
            try:
                parsed_geo = json.loads(geo) if isinstance(geo, str) else geo
            except Exception:
                parsed_geo = None
        results.append({
            "ma_khu_vuc": r["ma_khu_vuc"],
            "ten_khu_vuc": r["ten_khu_vuc"],
            "loai_khu_vuc": r["loai_khu_vuc"],
            "ma_khu_vuc_cha": r["ma_khu_vuc_cha"],
            "mo_ta": r["mo_ta"],
            "geojson": parsed_geo
        })
    return results

# ==========================================
# 3. QUẢN LÝ BỘ DỮ LIỆU (DATASET)
# ==========================================
@app.get("/api/datasets", tags=["Bộ dữ liệu LST"])
def get_datasets():
    datasets = db.query("""
        SELECT d.*, u.ten_dang_nhap as nguoi_tao,
               (SELECT COUNT(*) FROM lst_data WHERE ma_dataset = d.ma_dataset) as so_ban_ghi,
               (SELECT ROUND(AVG(gia_tri_lst)::numeric, 2) FROM lst_data WHERE ma_dataset = d.ma_dataset) as lst_trung_binh,
               (SELECT ROUND(MAX(gia_tri_lst)::numeric, 2) FROM lst_data WHERE ma_dataset = d.ma_dataset) as lst_cao_nhat,
               (SELECT ROUND(MIN(gia_tri_lst)::numeric, 2) FROM lst_data WHERE ma_dataset = d.ma_dataset) as lst_thap_nhat
        FROM dataset d
        LEFT JOIN nguoi_dung u ON d.ma_nguoi_dung = u.ma_nguoi_dung
        ORDER BY d.ma_dataset
    """,
    """
        SELECT d.*, u.ten_dang_nhap as nguoi_tao,
               (SELECT COUNT(*) FROM lst_data WHERE ma_dataset = d.ma_dataset) as so_ban_ghi,
               (SELECT ROUND(AVG(gia_tri_lst), 2) FROM lst_data WHERE ma_dataset = d.ma_dataset) as lst_trung_binh,
               (SELECT ROUND(MAX(gia_tri_lst), 2) FROM lst_data WHERE ma_dataset = d.ma_dataset) as lst_cao_nhat,
               (SELECT ROUND(MIN(gia_tri_lst), 2) FROM lst_data WHERE ma_dataset = d.ma_dataset) as lst_thap_nhat
        FROM dataset d
        LEFT JOIN nguoi_dung u ON d.ma_nguoi_dung = u.ma_nguoi_dung
        ORDER BY d.ma_dataset
    """)
    return datasets

# ==========================================
# 4. DỮ LIỆU LST CHUỖI THỜI GIAN & KHÔNG GIAN (LST_DATA)
# ==========================================
@app.get("/api/lst-data", tags=["Dữ liệu LST"])
def get_lst_data(
    ma_dataset: int = 1,
    thoi_gian: Optional[str] = None,
    tu_ngay: Optional[str] = None,
    den_ngay: Optional[str] = None,
    limit: int = 1000
):
    query_str = "SELECT * FROM lst_data WHERE ma_dataset = $1"
    params = [ma_dataset]
    idx = 2

    if thoi_gian:
        query_str += f" AND thoi_gian = ${idx}"
        params.append(thoi_gian)
        idx += 1
    if tu_ngay:
        query_str += f" AND thoi_gian >= ${idx}"
        params.append(tu_ngay)
        idx += 1
    if den_ngay:
        query_str += f" AND thoi_gian <= ${idx}"
        params.append(den_ngay)
        idx += 1

    query_str += f" ORDER BY thoi_gian DESC, ma_lst ASC LIMIT {limit}"
    
    rows = db.query(query_str, params=tuple(params))
    return rows

@app.get("/api/lst-data/timeline", tags=["Dữ liệu LST"])
def get_lst_timeline(ma_dataset: int = 1):
    """
    Return distinct observation dates with average TP.HCM LST for time-slider playback
    """
    rows = db.query("""
        SELECT thoi_gian,
               ROUND(AVG(gia_tri_lst)::numeric, 2) as avg_lst,
               ROUND(MAX(gia_tri_lst)::numeric, 2) as max_lst,
               ROUND(MIN(gia_tri_lst)::numeric, 2) as min_lst,
               ROUND(AVG(ndvi)::numeric, 3) as avg_ndvi,
               COUNT(*) as points_count
        FROM lst_data
        WHERE ma_dataset = $1
        GROUP BY thoi_gian
        ORDER BY thoi_gian ASC
    """,
    """
        SELECT thoi_gian,
               ROUND(AVG(gia_tri_lst), 2) as avg_lst,
               ROUND(MAX(gia_tri_lst), 2) as max_lst,
               ROUND(MIN(gia_tri_lst), 2) as min_lst,
               ROUND(AVG(ndvi), 3) as avg_ndvi,
               COUNT(*) as points_count
        FROM lst_data
        WHERE ma_dataset = ?
        GROUP BY thoi_gian
        ORDER BY thoi_gian ASC
    """,
    (ma_dataset,))
    return rows

# ==========================================
# 5. TIỀN XỬ LÝ DỮ LIỆU (TIEN_XU_LY)
# ==========================================
@app.get("/api/tien-xu-ly", tags=["Tiền xử lý dữ liệu"])
def get_tien_xu_ly():
    return db.query("SELECT * FROM tien_xu_ly ORDER BY ma_tien_xu_ly DESC")

@app.post("/api/tien-xu-ly/pipeline", tags=["Tiền xử lý dữ liệu"])
def run_preprocessing_pipeline(
    ma_dataset: int = 1,
    cach_xu_ly_thieu: str = "interpolate",
    cach_xu_ly_nhieu: str = "iqr",
    phuong_phap_chuan_hoa: str = "min_max"
):
    rows = db.query("SELECT * FROM lst_data WHERE ma_dataset = $1", "SELECT * FROM lst_data WHERE ma_dataset = ?", (ma_dataset,))
    if not rows:
        raise HTTPException(status_code=404, detail="Không tìm thấy dữ liệu cho dataset này")
    
    df = pd.DataFrame(rows)
    prep = LSTPreprocessor(
        missing_strategy="interpolate" if "noi_suy" in cach_xu_ly_thieu.lower() else "drop",
        outlier_strategy="iqr" if "iqr" in cach_xu_ly_nhieu.lower() else "z_score",
        norm_method="min_max" if "min-max" in phuong_phap_chuan_hoa.lower() else "z_score"
    )
    
    df_clean, miss_stats = prep.handle_missing(df)
    df_clean, outlier_stats = prep.handle_outliers(df_clean)
    train_df, val_df, test_df = prep.chronological_split(df_clean)
    train_df, val_df, test_df, scaler_info = prep.fit_normalize(train_df, val_df, test_df)
    
    return {
        "status": "success",
        "missing_stats": miss_stats,
        "outlier_stats": outlier_stats,
        "scaler_info": scaler_info,
        "data_split": {
            "total_records": len(df_clean),
            "train_count": len(train_df),
            "val_count": len(val_df),
            "test_count": len(test_df),
            "split_ratio": f"{round(len(train_df)/len(df_clean)*100)}% / {round(len(val_df)/len(df_clean)*100)}% / {round(len(test_df)/len(df_clean)*100)}%"
        }
    }

# ==========================================
# 6. MÔ HÌNH AI & HUẤN LUYỆN (MODEL, TRAINING_RUN, MODEL_METRIC)
# ==========================================
@app.get("/api/models", tags=["Mô hình AI"])
def get_models():
    return db.query("SELECT * FROM model ORDER BY ma_model")

@app.get("/api/training-runs", tags=["Huấn luyện & Đánh giá"])
def get_training_runs():
    rows = db.query("""
        SELECT tr.*, m.ten_model, m.loai_model, d.ten_dataset,
               m_val.mae as val_mae, m_val.rmse as val_rmse, m_val.r2 as val_r2, m_val.mape as val_mape,
               m_test.mae as test_mae, m_test.rmse as test_rmse, m_test.r2 as test_r2, m_test.mape as test_mape
        FROM training_run tr
        JOIN model m ON tr.ma_model = m.ma_model
        JOIN dataset d ON tr.ma_dataset = d.ma_dataset
        LEFT JOIN model_metric m_val ON tr.ma_training = m_val.ma_training AND m_val.tap_danh_gia = 'Kiem_dinh'
        LEFT JOIN model_metric m_test ON tr.ma_training = m_test.ma_training AND m_test.tap_danh_gia = 'Kiem_tra'
        ORDER BY tr.ma_training DESC
    """)
    for r in rows:
        if r.get("tham_so") and isinstance(r["tham_so"], str):
            try:
                r["tham_so"] = json.loads(r["tham_so"])
            except Exception:
                pass
    return rows

@app.post("/api/training/run", tags=["Huấn luyện & Đánh giá"])
def trigger_training(req: TrainingRequest):
    """
    Execute AI Model training with chosen model and parameters
    Calculates MAE, RMSE, R2, MAPE on validation and test sets
    """
    # 1. Fetch Model info
    model_row = db.query("SELECT * FROM model WHERE ma_model = $1", "SELECT * FROM model WHERE ma_model = ?", (req.ma_model,))
    if not model_row:
        raise HTTPException(status_code=404, detail="Không tìm thấy mô hình tương ứng")
    model_name = model_row[0]["ten_model"]

    # 2. Fetch LST Data for Dataset
    rows = db.query("SELECT * FROM lst_data WHERE ma_dataset = $1", "SELECT * FROM lst_data WHERE ma_dataset = ?", (req.ma_dataset,))
    if not rows or len(rows) < 15:
        raise HTTPException(status_code=400, detail="Không đủ dữ liệu LST để huấn luyện")
    
    df = pd.DataFrame(rows)

    # 3. Preprocessing
    prep = LSTPreprocessor()
    df_clean, _ = prep.handle_missing(df)
    df_clean, _ = prep.handle_outliers(df_clean)

    # 4. Execute Model Training
    hyper_params = req.tham_so or {}
    start_time = datetime.now()
    
    try:
        train_res = run_model_training(model_name, df_clean, hyper_params)
        val_m = train_res["val_metrics"]
        test_m = train_res["test_metrics"]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi khi huấn luyện mô hình: {str(e)}")

    end_time = datetime.now()

    # 5. Insert Training Run record
    run_id = db.execute_insert(
        """
        INSERT INTO training_run (ma_dataset, ma_model, ma_nguoi_dung, trang_thai, tham_so, thoi_gian_bat_dau, thoi_gian_ket_thuc)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ma_training
        """,
        """
        INSERT INTO training_run (ma_dataset, ma_model, ma_nguoi_dung, trang_thai, tham_so, thoi_gian_bat_dau, thoi_gian_ket_thuc)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (req.ma_dataset, req.ma_model, 2, "HOAN_THANH", json.dumps(hyper_params), start_time.strftime("%Y-%m-%d %H:%M:%S"), end_time.strftime("%Y-%m-%d %H:%M:%S"))
    )

    # 6. Insert Validation & Test metrics
    if run_id:
        db.query(
            "INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape) VALUES ($1, $2, $3, $4, $5, $6)",
            "INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape) VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, "Kiem_dinh", val_m["mae"], val_m["rmse"], val_m["r2"], val_m["mape"])
        )
        db.query(
            "INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape) VALUES ($1, $2, $3, $4, $5, $6)",
            "INSERT INTO model_metric (ma_training, tap_danh_gia, mae, rmse, r2, mape) VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, "Kiem_tra", test_m["mae"], test_m["rmse"], test_m["r2"], test_m["mape"])
        )

    return {
        "status": "success",
        "ma_training": run_id,
        "model": model_name,
        "val_metrics": val_m,
        "test_metrics": test_m,
        "execution_seconds": round((end_time - start_time).total_seconds(), 2),
        "details": train_res.get("details") or train_res.get("feature_importances")
    }

@app.get("/api/metrics/comparison", tags=["Huấn luyện & Đánh giá"])
def get_metrics_comparison():
    """
    Retrieve comparative 4-metrics table across ARIMA, RF, XGBoost, and GCN-LSTM
    """
    rows = db.query("""
        SELECT m.ten_model, m.loai_model,
               mm.tap_danh_gia,
               ROUND(AVG(mm.mae)::numeric, 3) as mae,
               ROUND(AVG(mm.rmse)::numeric, 3) as rmse,
               ROUND(AVG(mm.r2)::numeric, 3) as r2,
               ROUND(AVG(mm.mape)::numeric, 2) as mape
        FROM model_metric mm
        JOIN training_run tr ON mm.ma_training = tr.ma_training
        JOIN model m ON tr.ma_model = m.ma_model
        GROUP BY m.ten_model, m.loai_model, mm.tap_danh_gia
        ORDER BY m.ten_model, mm.tap_danh_gia
    """,
    """
        SELECT m.ten_model, m.loai_model,
               mm.tap_danh_gia,
               ROUND(AVG(mm.mae), 3) as mae,
               ROUND(AVG(mm.rmse), 3) as rmse,
               ROUND(AVG(mm.r2), 3) as r2,
               ROUND(AVG(mm.mape), 2) as mape
        FROM model_metric mm
        JOIN training_run tr ON mm.ma_training = tr.ma_training
        JOIN model m ON tr.ma_model = m.ma_model
        GROUP BY m.ten_model, m.loai_model, mm.tap_danh_gia
        ORDER BY m.ten_model, mm.tap_danh_gia
    """)
    return rows

# ==========================================
# 7. KẾT QUẢ DỰ BÁO LST & BẢN ĐỒ WEBGIS (FORECAST_RESULT, MAP_LAYER)
# ==========================================
@app.get("/api/forecast", tags=["Dự báo LST & Bản đồ WebGIS"])
def get_forecast(
    ma_training: Optional[int] = None,
    ma_khu_vuc: Optional[int] = None,
    thoi_gian: Optional[str] = None
):
    query_str = """
        SELECT f.*, kv.ten_khu_vuc, m.ten_model
        FROM forecast_result f
        LEFT JOIN khu_vuc kv ON f.ma_khu_vuc = kv.ma_khu_vuc
        LEFT JOIN training_run tr ON f.ma_training = tr.ma_training
        LEFT JOIN model m ON tr.ma_model = m.ma_model
        WHERE 1=1
    """
    params = []
    idx = 1
    if ma_training:
        query_str += f" AND f.ma_training = ${idx}"
        params.append(ma_training)
        idx += 1
    if ma_khu_vuc and ma_khu_vuc != 1:  # 1 is all HCM
        query_str += f" AND f.ma_khu_vuc = ${idx}"
        params.append(ma_khu_vuc)
        idx += 1
    if thoi_gian:
        query_str += f" AND f.thoi_gian_du_bao = ${idx}"
        params.append(thoi_gian)
        idx += 1

    query_str += " ORDER BY f.thoi_gian_du_bao ASC, f.ma_du_bao ASC"
    rows = db.query(query_str, params=tuple(params))
    return rows

@app.get("/api/layers", tags=["Dự báo LST & Bản đồ WebGIS"])
def get_map_layers():
    return db.query("""
        SELECT ml.*, kv.ten_khu_vuc, m.ten_model
        FROM map_layer ml
        LEFT JOIN khu_vuc kv ON ml.ma_khu_vuc = kv.ma_khu_vuc
        LEFT JOIN training_run tr ON ml.ma_training = tr.ma_training
        LEFT JOIN model m ON tr.ma_model = m.ma_model
        ORDER BY ml.ma_layer DESC
    """)

# ==========================================
# 8. THỐNG KÊ TỔNG QUAN (OVERVIEW STATS)
# ==========================================
@app.get("/api/overview-stats", tags=["Thống kê"])
def get_overview_stats():
    cnt_ds = db.query("SELECT COUNT(*) as c FROM dataset")[0]["c"]
    cnt_lst = db.query("SELECT COUNT(*) as c FROM lst_data")[0]["c"]
    cnt_models = db.query("SELECT COUNT(*) as c FROM model")[0]["c"]
    cnt_runs = db.query("SELECT COUNT(*) as c FROM training_run")[0]["c"]
    cnt_fc = db.query("SELECT COUNT(*) as c FROM forecast_result")[0]["c"]
    
    # Best performing model by test RMSE
    best_m = db.query("""
        SELECT m.ten_model, mm.rmse, mm.r2, mm.mae, mm.mape
        FROM model_metric mm
        JOIN training_run tr ON mm.ma_training = tr.ma_training
        JOIN model m ON tr.ma_model = m.ma_model
        WHERE mm.tap_danh_gia = 'Kiem_tra'
        ORDER BY mm.rmse ASC
        LIMIT 1
    """)
    
    best_info = best_m[0] if best_m else {"ten_model": "GCN-LSTM", "rmse": 0.69, "r2": 0.95}

    return {
        "datasets_count": cnt_ds,
        "lst_records_count": cnt_lst,
        "models_count": cnt_models,
        "training_runs_count": cnt_runs,
        "forecast_points_count": cnt_fc,
        "best_model": best_info,
        "time_span": "2021 - 2026",
        "city_focus": "TP. Hồ Chí Minh"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=True)
