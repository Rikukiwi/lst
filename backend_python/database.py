"""
Database Layer supporting PostgreSQL (PostGIS) and SQLite Fallback
Provides uniform interface for querying the 10 entities:
- nguoi_dung
- dataset
- khu_vuc
- lst_data
- tien_xu_ly
- model
- training_run
- model_metric
- forecast_result
- map_layer
"""

import os
import json
import sqlite3
from typing import List, Dict, Any, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "123")
DB_NAME = os.getenv("DB_NAME", "lst_hcm_db")

SQLITE_DB_PATH = os.path.join(os.path.dirname(__file__), "lst_hcm.db")

class DatabaseManager:
    def __init__(self):
        self.use_postgres = False
        self.pg_conn_str = f"host={DB_HOST} port={DB_PORT} user={DB_USER} password={DB_PASSWORD} dbname={DB_NAME}"
        self._check_connection()

    def _check_connection(self):
        try:
            conn = psycopg2.connect(self.pg_conn_str, connect_timeout=3)
            conn.close()
            self.use_postgres = True
            print("Connected successfully to PostgreSQL / PostGIS!")
        except Exception as e:
            self.use_postgres = False
            print(f"PostgreSQL connection fallback to SQLite ({e})")
            self._init_sqlite()

    def get_pg_connection(self):
        return psycopg2.connect(self.pg_conn_str)

    def get_sqlite_connection(self):
        conn = sqlite3.connect(SQLITE_DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn

    def query(self, sql_pg: str, sql_sqlite: Optional[str] = None, params: tuple = ()) -> List[Dict[str, Any]]:
        """
        Execute query and return list of dicts
        """
        import re
        if self.use_postgres:
            try:
                # Convert $1, $2, ... to %s for psycopg2
                pg_sql = re.sub(r'\$\d+', '%s', sql_pg)
                with self.get_pg_connection() as conn:
                    with conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute(pg_sql, params)
                        if cur.description:
                            return [dict(r) for r in cur.fetchall()]
                        conn.commit()
                        return []
            except Exception as e:
                # If error in PG, fallback
                print(f"PostgreSQL query error: {e}, falling back to SQLite")
                self.use_postgres = False
                self._init_sqlite()

        # SQLite execution
        query_sql = sql_sqlite or sql_pg
        # Convert $1, $2, ... to ? for SQLite
        import re
        query_sql = re.sub(r'\$\d+', '?', query_sql)
        with self.get_sqlite_connection() as conn:
            cur = conn.cursor()
            cur.execute(query_sql, params)
            if cur.description:
                rows = cur.fetchall()
                return [dict(r) for r in rows]
            conn.commit()
            return []

    def execute_insert(self, sql_pg: str, sql_sqlite: Optional[str] = None, params: tuple = ()) -> Optional[int]:
        import re
        if self.use_postgres:
            try:
                pg_sql = re.sub(r'\$\d+', '%s', sql_pg)
                with self.get_pg_connection() as conn:
                    with conn.cursor() as cur:
                        cur.execute(pg_sql, params)
                        inserted_id = None
                        if "RETURNING" in pg_sql.upper():
                            inserted_id = cur.fetchone()[0]
                        conn.commit()
                        return inserted_id
            except Exception as e:
                print(f"PostgreSQL insert error: {e}, falling back to SQLite")
                self.use_postgres = False
                self._init_sqlite()

        query_sql = sql_sqlite or sql_pg
        import re
        query_sql = re.sub(r'RETURNING\s+\w+', '', query_sql, flags=re.IGNORECASE)
        query_sql = re.sub(r'\$\d+', '?', query_sql)
        with self.get_sqlite_connection() as conn:
            cur = conn.cursor()
            cur.execute(query_sql, params)
            conn.commit()
            return cur.lastrowid

    def _init_sqlite(self):
        """Initialize SQLite tables matching the 10 entities"""
        with self.get_sqlite_connection() as conn:
            cur = conn.cursor()
            cur.executescript("""
            CREATE TABLE IF NOT EXISTS nguoi_dung (
                ma_nguoi_dung INTEGER PRIMARY KEY AUTOINCREMENT,
                ten_dang_nhap TEXT NOT NULL UNIQUE,
                mat_khau_ma_hoa TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                vai_tro TEXT NOT NULL DEFAULT 'NGUOI_XEM',
                trang_thai TEXT NOT NULL DEFAULT 'HOAT_DONG'
            );

            CREATE TABLE IF NOT EXISTS dataset (
                ma_dataset INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_nguoi_dung INTEGER NOT NULL,
                ten_dataset TEXT NOT NULL,
                mo_ta TEXT,
                nguon_du_lieu TEXT NOT NULL,
                thoi_gian_bat_dau TEXT,
                thoi_gian_ket_thuc TEXT,
                trang_thai TEXT NOT NULL DEFAULT 'MOI_TAI',
                ngay_tao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS khu_vuc (
                ma_khu_vuc INTEGER PRIMARY KEY AUTOINCREMENT,
                ten_khu_vuc TEXT NOT NULL,
                loai_khu_vuc TEXT NOT NULL,
                ma_khu_vuc_cha INTEGER,
                ranh_gioi TEXT,
                mo_ta TEXT
            );

            CREATE TABLE IF NOT EXISTS lst_data (
                ma_lst INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_dataset INTEGER NOT NULL,
                thoi_gian TEXT NOT NULL,
                vi_do REAL NOT NULL,
                kinh_do REAL NOT NULL,
                gia_tri_lst REAL,
                ndvi REAL,
                luong_mua REAL,
                do_am_dat REAL,
                lop_phu_be_mat TEXT,
                UNIQUE(ma_dataset, thoi_gian, kinh_do, vi_do)
            );

            CREATE TABLE IF NOT EXISTS tien_xu_ly (
                ma_tien_xu_ly INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_dataset INTEGER NOT NULL,
                cach_xu_ly_thieu TEXT,
                cach_xu_ly_nhieu TEXT,
                phuong_phap_chuan_hoa TEXT DEFAULT 'Khong',
                ngay_ket_thuc_train TEXT,
                ngay_ket_thuc_val TEXT,
                ngay_tao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS model (
                ma_model INTEGER PRIMARY KEY AUTOINCREMENT,
                ten_model TEXT NOT NULL UNIQUE,
                loai_model TEXT NOT NULL,
                mo_ta TEXT,
                trang_thai TEXT DEFAULT 'KHA_DUNG'
            );

            CREATE TABLE IF NOT EXISTS training_run (
                ma_training INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_dataset INTEGER NOT NULL,
                ma_tien_xu_ly INTEGER,
                ma_model INTEGER NOT NULL,
                ma_nguoi_dung INTEGER,
                thoi_gian_bat_dau TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                thoi_gian_ket_thuc TIMESTAMP,
                trang_thai TEXT NOT NULL DEFAULT 'DANG_CHAY',
                tham_so TEXT
            );

            CREATE TABLE IF NOT EXISTS model_metric (
                ma_metric INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_training INTEGER NOT NULL,
                tap_danh_gia TEXT NOT NULL,
                mae REAL,
                rmse REAL,
                r2 REAL,
                mape REAL
            );

            CREATE TABLE IF NOT EXISTS forecast_result (
                ma_du_bao INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_training INTEGER NOT NULL,
                ma_khu_vuc INTEGER,
                thoi_gian_du_bao TEXT NOT NULL,
                vi_do REAL NOT NULL,
                kinh_do REAL NOT NULL,
                gia_tri_lst_du_bao REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS map_layer (
                ma_layer INTEGER PRIMARY KEY AUTOINCREMENT,
                ma_training INTEGER,
                ma_khu_vuc INTEGER,
                ten_layer TEXT NOT NULL,
                thoi_gian TEXT,
                duong_dan_du_lieu TEXT,
                loai_du_lieu TEXT,
                mo_ta TEXT
            );
            """)
            conn.commit()

db = DatabaseManager()
