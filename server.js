const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// File lưu lịch sử
const HISTORY_FILE = 'history.json';
const MAX_HISTORY = 230;

// API endpoints
const API_BET = 'https://lc79txmd5-production.up.railway.app/api/bet';
const API_RESULTS = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=5848a1b6c31c549ee87fa61fd1b3f3f6';

// Dữ liệu
let currentBetData = null;
let prevBetData = null;
let resultMap = new Map();
let history = [];
let currentPrediction = {
    verdict: 'hold',
    confidence: 0,
    reason: 'Đang phân tích...',
    timestamp: null
};
let countdown = 20;
let currentSessionId = null;
let isLocked = false;
let rawVerdictsBuffer = [];

// ==================== ĐỌC/GHI LỊCH SỬ ====================
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
            if (!Array.isArray(history)) history = [];
            if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
        } else {
            history = [];
        }
    } catch (e) {
        console.error('Lỗi đọc history:', e);
        history = [];
    }
}

function saveHistory() {
    try {
        if (history.length > MAX_HISTORY) {
            history = history.slice(0, MAX_HISTORY);
        }
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('Lỗi ghi history:', e);
    }
}

// ==================== LẤY KẾT QUẢ THỰC TẾ ====================
async function fetchResults() {
    try {
        const res = await fetch(API_RESULTS);
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data && data.list) {
            data.list.forEach(item => {
                resultMap.set(item.id, item.resultTruyenThong?.toLowerCase());
            });
            updateHistoryResults();
        }
    } catch (e) {
        console.error('Lỗi fetch kết quả:', e);
    }
}

function updateHistoryResults() {
    let changed = false;
    for (let rec of history) {
        const actual = resultMap.get(rec.sessionId);
        if (actual && !rec.result) {
            rec.result = actual;
            rec.correct = (rec.prediction === rec.result);
            changed = true;
        } else if (actual && rec.result !== actual) {
            rec.result = actual;
            rec.correct = (rec.prediction === rec.result);
            changed = true;
        }
    }
    if (changed) saveHistory();
}

// ==================== THUẬT TOÁN DỰ ĐOÁN ====================
function analyzeAlgorithm(data, prev) {
    const totalMoney = data.taiAmount + data.xiuAmount;
    if (totalMoney === 0) {
        return { verdict: 'hold', confidence: 30, reason: 'Chưa có dữ liệu', inflowPct: 0.5 };
    }
    
    let taiInflow = 0.5;
    let xiuInflow = 0.5;
    
    if (prev && prev.taiAmount && prev.xiuAmount) {
        const deltaTai = data.taiAmount - prev.taiAmount;
        const deltaXiu = data.xiuAmount - prev.xiuAmount;
        const totalDelta = deltaTai + deltaXiu;
        
        if (totalDelta > 0) {
            taiInflow = deltaTai / totalDelta;
            xiuInflow = deltaXiu / totalDelta;
        } else {
            taiInflow = data.taiAmount / totalMoney;
            xiuInflow = data.xiuAmount / totalMoney;
        }
    } else {
        taiInflow = data.taiAmount / totalMoney;
        xiuInflow = data.xiuAmount / totalMoney;
    }
    
    let verdict = 'hold';
    let confidence = 45;
    let reason = '';
    
    if (taiInflow > 0.60) {
        verdict = 'xiu';
        confidence = 65 + Math.min(30, (taiInflow - 0.60) * 200);
        reason = `💰 ${(taiInflow*100).toFixed(0)}% dòng mới đổ vào TÀI → nhà cái chống → XỈU`;
    }
    else if (xiuInflow > 0.60) {
        verdict = 'tai';
        confidence = 65 + Math.min(30, (xiuInflow - 0.60) * 200);
        reason = `💰 ${(xiuInflow*100).toFixed(0)}% dòng mới đổ vào XỈU → nhà cái chống → TÀI`;
    }
    else {
        const taiRatio = data.taiAmount / totalMoney;
        if (taiRatio > 0.57) {
            verdict = 'xiu';
            confidence = 55;
            reason = `⚖️ Tài chiếm ${(taiRatio*100).toFixed(0)}% tổng tiền → nghiêng XỈU`;
        } else if (taiRatio < 0.43) {
            verdict = 'tai';
            confidence = 55;
            reason = `⚖️ Xỉu chiếm ${((1-taiRatio)*100).toFixed(0)}% tổng tiền → nghiêng TÀI`;
        } else {
            verdict = 'hold';
            confidence = 35;
            reason = `⏳ Cân bằng (Tài ${(taiRatio*100).toFixed(0)}% - Xỉu ${((1-taiRatio)*100).toFixed(0)}%) → chờ`;
        }
    }
    
    confidence = Math.min(92, Math.max(30, Math.floor(confidence)));
    return { verdict, confidence, reason, inflowPct: Math.max(taiInflow, xiuInflow) };
}

function lockPrediction(sessionId, verdict, confidence, reason) {
    if (history.find(h => h.sessionId === sessionId)) return false;
    
    const record = {
        sessionId: sessionId,
        prediction: verdict,
        confidence: confidence,
        reason: reason,
        timestamp: Date.now(),
        timeStr: new Date().toLocaleString('vi-VN'),
        result: resultMap.get(sessionId) || null,
        correct: null
    };
    if (record.result) record.correct = (record.prediction === record.result);
    
    history.unshift(record);
    saveHistory();
    return true;
}

// ==================== FETCH DATA ====================
async function fetchBetData() {
    try {
        const res = await fetch(API_BET);
        if (!res.ok) throw new Error();
        const data = await res.json();
        currentBetData = data;
        
        const newSid = data.sessionId;
        
        if (currentSessionId !== null && currentSessionId !== newSid) {
            currentSessionId = newSid;
            isLocked = false;
            rawVerdictsBuffer = [];
            countdown = 20;
        } else if (currentSessionId === null) {
            currentSessionId = newSid;
            countdown = 20;
        }
        
        if (!isLocked && currentBetData) {
            const raw = analyzeAlgorithm(currentBetData, prevBetData);
            
            rawVerdictsBuffer.push({ verdict: raw.verdict, confidence: raw.confidence, timestamp: Date.now(), inflowPct: raw.inflowPct });
            if (rawVerdictsBuffer.length > 5) rawVerdictsBuffer.shift();
            
            let finalVerdict = raw.verdict;
            let finalConfidence = raw.confidence;
            let finalReason = raw.reason;
            
            if (raw.inflowPct > 0.75 && raw.verdict !== 'hold') {
                finalVerdict = raw.verdict;
                finalConfidence = Math.min(94, raw.confidence + 10);
                finalReason = `🚨 BIẾN ĐỘNG ${(raw.inflowPct*100).toFixed(0)}% → ${raw.verdict === 'tai' ? 'XỈU' : 'TÀI'}`;
            } else {
                const last3 = rawVerdictsBuffer.slice(-3);
                if (last3.length === 3 && last3.every(v => v.verdict === last3[0].verdict && v.verdict !== 'hold')) {
                    finalVerdict = last3[0].verdict;
                    finalConfidence = Math.floor(last3.reduce((s, v) => s + v.confidence, 0) / 3);
                    finalReason = `🔒 Ổn định 3s: ${finalVerdict === 'tai' ? 'XỈU' : 'TÀI'}`;
                }
            }
            
            currentPrediction = {
                verdict: finalVerdict,
                confidence: finalConfidence,
                reason: finalReason,
                timestamp: Date.now(),
                inflowPct: raw.inflowPct
            };
            
            if (finalVerdict !== 'hold' && finalConfidence >= 60 && !isLocked) {
                if (lockPrediction(currentSessionId, finalVerdict, finalConfidence, finalReason)) {
                    isLocked = true;
                }
            }
        }
        
        if (!isLocked && countdown > 0) {
            countdown--;
            if (countdown === 0 && !isLocked && currentBetData) {
                const raw = analyzeAlgorithm(currentBetData, prevBetData);
                if (raw.verdict !== 'hold') {
                    lockPrediction(currentSessionId, raw.verdict, raw.confidence, `Hết giờ: ${raw.reason}`);
                } else {
                    const total = currentBetData.taiAmount + currentBetData.xiuAmount;
                    const taiRatio = currentBetData.taiAmount / total;
                    const forced = taiRatio > 0.5 ? 'tai' : 'xiu';
                    lockPrediction(currentSessionId, forced, 55, 'Hết giờ, chốt theo tổng tiền');
                }
                isLocked = true;
            }
        }
        
        prevBetData = currentBetData ? { ...currentBetData } : null;
    } catch (e) {
        console.error('Lỗi fetch bet data:', e);
    }
}

// ==================== API ====================
app.get('/api/predict', (req, res) => {
    const stats = {
        total: history.length,
        correct: history.filter(h => h.correct === true).length,
        wrong: history.filter(h => h.correct === false).length,
        ratio: 0,
        bestStreak: 0
    };
    
    if (stats.total > 0) {
        stats.ratio = (stats.correct / stats.total * 100).toFixed(1);
        let currentStreak = 0;
        for (let h of history) {
            if (h.correct === true) {
                currentStreak++;
                stats.bestStreak = Math.max(stats.bestStreak, currentStreak);
            } else {
                currentStreak = 0;
            }
        }
    }
    
    res.json({
        success: true,
        timestamp: Date.now(),
        currentData: currentBetData,
        prediction: {
            ...currentPrediction,
            countdown: countdown,
            isLocked: isLocked,
            sessionId: currentSessionId
        },
        history: history.slice(0, 50),
        statistics: stats
    });
});

// ==================== HTML GIAO DIỆN ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Tài Xỉu - Dự đoán từ API</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: system-ui, 'Segoe UI', sans-serif; }
        body { background: linear-gradient(145deg, #0a0f1e 0%, #0c1222 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 20px; }
        .header h1 { font-size: 1.8rem; background: linear-gradient(135deg, #F9B43A, #FB6C3E); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .badge { background: #1E293B; padding: 4px 12px; border-radius: 40px; font-size: 0.7rem; display: inline-block; margin-top: 6px; color: #94A3B8; }
        .stats-summary { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
        .stat-card { background: linear-gradient(165deg, #0F172A, #0B1120); border-radius: 28px; padding: 12px 20px; flex: 1; text-align: center; border: 1px solid rgba(249, 115, 22, 0.2); }
        .stat-card .label { font-size: 0.7rem; color: #8B9BB0; }
        .stat-card .value { font-size: 1.8rem; font-weight: 800; }
        .stat-card .value.correct { color: #4ADE80; }
        .stat-card .value.wrong { color: #F87171; }
        .stat-card .value.ratio { color: #FBBF24; }
        .main-timer-card { background: linear-gradient(165deg, #0F172A, #0B1120); border-radius: 60px; padding: 20px; text-align: center; margin-bottom: 25px; border: 1px solid rgba(249, 115, 22, 0.3); }
        .timer-digit { font-size: 5.5rem; font-weight: 800; font-family: 'Courier New', monospace; letter-spacing: 8px; background: linear-gradient(135deg, #F97316, #FBBF24); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .timer-label { font-size: 0.8rem; color: #8B9BB0; margin-top: 5px; }
        .session-info { display: flex; justify-content: center; gap: 20px; margin-top: 10px; font-size: 0.8rem; flex-wrap: wrap; }
        .dashboard { display: flex; flex-wrap: wrap; gap: 24px; }
        .left-panel { flex: 1.2; min-width: 280px; }
        .right-panel { flex: 1.8; min-width: 360px; }
        .card { background: rgba(18, 25, 45, 0.8); backdrop-filter: blur(8px); border-radius: 36px; padding: 20px; border: 1px solid rgba(255,255,255,0.08); margin-bottom: 20px; }
        .stat-grid { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
        .stat-item { background: #0F172A; border-radius: 28px; padding: 12px; flex: 1; text-align: center; }
        .stat-number { font-size: 1.5rem; font-weight: 800; }
        .tai-color { color: #FB923C; }
        .xiu-color { color: #60A5FA; }
        .live-prediction { background: #0B1120; border-radius: 32px; padding: 18px; text-align: center; margin: 15px 0; }
        .current-verdict { font-size: 2rem; font-weight: 800; padding: 14px; border-radius: 50px; display: inline-block; min-width: 220px; }
        .current-verdict.tai { background: #F9731620; color: #F97316; }
        .current-verdict.xiu { background: #3B82F620; color: #3B82F6; }
        .current-verdict.hold { background: #33415560; color: #CBD5E1; }
        .confidence-ring { width: 100%; background: #1E293B; border-radius: 30px; height: 10px; margin: 12px 0; overflow: hidden; }
        .confidence-fill { height: 100%; background: linear-gradient(90deg, #F97316, #FBBF24); width: 0%; transition: width 0.3s ease; }
        .reason-box { background: #111827; padding: 12px; border-radius: 24px; font-size: 0.8rem; margin-top: 12px; border-left: 3px solid #F97316; text-align: left; }
        .history-table { max-height: 450px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 8px 5px; text-align: center; border-bottom: 1px solid #1E293B; }
        th { background: #0F172A; position: sticky; top: 0; }
        .correct { color: #4ADE80; }
        .wrong { color: #F87171; }
        .footer { text-align: center; font-size: 0.7rem; color: #4A5A7A; margin-top: 20px; }
        @media (max-width: 700px) {
            .timer-digit { font-size: 3rem; letter-spacing: 4px; }
            .current-verdict { font-size: 1.3rem; min-width: 160px; }
            .stat-card .value { font-size: 1.2rem; }
        }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🎲 TÀI XỈU · DỰ ĐOÁN TỪ API</h1>
        <div class="badge">⚡ Thuật toán chạy trên server | Lưu 230 phiên | Thống kê đúng/sai</div>
    </div>

    <div class="stats-summary" id="statsSummary">
        <div class="stat-card"><div class="label">📊 Tổng phiên</div><div class="value" id="totalSessions">0</div></div>
        <div class="stat-card"><div class="label">✅ Đúng</div><div class="value correct" id="correctCount">0</div></div>
        <div class="stat-card"><div class="label">❌ Sai</div><div class="value wrong" id="wrongCount">0</div></div>
        <div class="stat-card"><div class="label">📈 Tỉ lệ đúng</div><div class="value ratio" id="ratioPercent">0%</div></div>
        <div class="stat-card"><div class="label">🔥 Chuỗi đúng nhất</div><div class="value" id="bestStreak">0</div></div>
    </div>

    <div class="main-timer-card">
        <div class="timer-digit" id="countdownDisplay">--</div>
        <div class="timer-label">⏱️ GIÂY CÒN LẠI</div>
        <div class="session-info">
            <span>🎯 Phiên: <strong id="sessionId">--</strong></span>
            <span>🎲 Tick: <strong id="tickValue">--</strong></span>
            <span>🕐 Cập nhật: <strong id="updateTime">--</strong></span>
        </div>
    </div>

    <div class="dashboard">
        <div class="left-panel">
            <div class="card">
                <div class="stat-grid">
                    <div class="stat-item"><div class="stat-label">🔥 TÀI TIỀN</div><div class="stat-number tai-color" id="taiAmount">--</div><div class="stat-label" id="taiUsers">👥 0</div></div>
                    <div class="stat-item"><div class="stat-label">💧 XỈU TIỀN</div><div class="stat-number xiu-color" id="xiuAmount">--</div><div class="stat-label" id="xiuUsers">👥 0</div></div>
                    <div class="stat-item"><div class="stat-label">📊 TỔNG</div><div class="stat-number" style="color:#C084FC;" id="totalAmount">--</div><div class="stat-label" id="totalUsers">👥 0</div></div>
                </div>
                
                <div class="live-prediction">
                    <div id="verdictDisplay" class="current-verdict hold">🔍 ĐANG TẢI...</div>
                    <div class="confidence-ring"><div class="confidence-fill" id="confidenceFill"></div></div>
                    <div id="confidencePercent" style="font-size:0.75rem;">Độ tin cậy: --</div>
                    <div class="reason-box" id="reasonText">Đang kết nối server...</div>
                </div>
                
                <div class="auto-status" id="liveStatus">🟢 Kết nối realtime</div>
            </div>
        </div>

        <div class="right-panel">
            <div class="card">
                <h3 style="color:white; font-size:1.1rem; margin-bottom:10px;">📜 LỊCH SỬ DỰ ĐOÁN</h3>
                <div class="history-table">
                    <table id="historyTable">
                        <thead><tr><th>Phiên</th><th>Dự đoán</th><th>Kết quả</th><th>Đ/S</th><th>Thời gian</th><th>%</th></tr></thead>
                        <tbody id="historyBody"><tr><td colspan="6">Đang tải...</td></tr></tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
    <div class="footer">🎯 Dữ liệu realtime | Dự đoán từ thuật toán server | Lưu 230 phiên tự động</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/predict');
            const data = await res.json();
            if (!data.success) return;
            
            document.getElementById('totalSessions').innerText = data.statistics.total;
            document.getElementById('correctCount').innerText = data.statistics.correct;
            document.getElementById('wrongCount').innerText = data.statistics.wrong;
            document.getElementById('ratioPercent').innerHTML = data.statistics.ratio + '%';
            document.getElementById('bestStreak').innerText = data.statistics.bestStreak;
            
            if (data.prediction) {
                document.getElementById('countdownDisplay').innerText = data.prediction.countdown !== undefined ? data.prediction.countdown : '--';
                document.getElementById('sessionId').innerText = data.prediction.sessionId || '--';
                
                const verdict = data.prediction.verdict;
                const confidence = data.prediction.confidence || 0;
                
                if (verdict === 'tai') {
                    document.getElementById('verdictDisplay').className = 'current-verdict tai';
                    document.getElementById('verdictDisplay').innerHTML = '🎲 DỰ ĐOÁN: TÀI 🔥';
                } else if (verdict === 'xiu') {
                    document.getElementById('verdictDisplay').className = 'current-verdict xiu';
                    document.getElementById('verdictDisplay').innerHTML = '🎲 DỰ ĐOÁN: XỈU 💧';
                } else {
                    document.getElementById('verdictDisplay').className = 'current-verdict hold';
                    document.getElementById('verdictDisplay').innerHTML = '⚠️ CHƯA RÕ - QUAN SÁT';
                }
                
                document.getElementById('confidenceFill').style.width = confidence + '%';
                document.getElementById('confidencePercent').innerHTML = 'Độ tin cậy: ' + confidence + '%';
                document.getElementById('reasonText').innerHTML = '<strong>🧠 ' + (data.prediction.reason || 'Đang phân tích...') + '</strong>';
                document.getElementById('liveStatus').innerHTML = data.prediction.isLocked ? '🔒 Đã chốt phiên #' + data.prediction.sessionId : '🟢 Đếm ngược ' + data.prediction.countdown + 's | Chưa chốt';
            }
            
            if (data.currentData) {
                document.getElementById('taiAmount').innerText = data.currentData.taiAmount?.toLocaleString() || '--';
                document.getElementById('xiuAmount').innerText = data.currentData.xiuAmount?.toLocaleString() || '--';
                document.getElementById('totalAmount').innerText = data.currentData.totalAmount?.toLocaleString() || '--';
                document.getElementById('taiUsers').innerHTML = '👥 ' + (data.currentData.taiUsers || 0);
                document.getElementById('xiuUsers').innerHTML = '👥 ' + (data.currentData.xiuUsers || 0);
                document.getElementById('totalUsers').innerHTML = '👥 ' + (data.currentData.totalUsers || 0);
                document.getElementById('tickValue').innerText = (data.currentData.tick || 0) + '.' + (data.currentData.subTick || 0);
                document.getElementById('updateTime').innerText = new Date().toLocaleTimeString();
            }
            
            if (data.history && data.history.length > 0) {
                const tbody = document.getElementById('historyBody');
                let html = '';
                for (let h of data.history.slice(0, 50)) {
                    const predText = h.prediction === 'tai' ? '🔥 TÀI' : '💧 XỈU';
                    const predColor = h.prediction === 'tai' ? 'style="color:#FB923C"' : 'style="color:#60A5FA"';
                    const resultText = h.result ? (h.result === 'tai' ? '🔥 TÀI' : '💧 XỈU') : '⏳ Chờ';
                    const status = h.correct === true ? '<span class="correct">✅ ĐÚNG</span>' : (h.correct === false ? '<span class="wrong">❌ SAI</span>' : '<span class="pending">⚪</span>');
                    html += '<tr><td>' + h.sessionId + '</td><td ' + predColor + '>' + predText + '</td><td>' + resultText + '</td><td>' + status + '</td><td style="font-size:0.65rem">' + (h.timeStr || '') + '</td><td>' + h.confidence + '%</td></tr>';
                }
                tbody.innerHTML = html;
            }
        } catch (err) {
            console.error('Lỗi:', err);
        }
    }
    
    fetchData();
    setInterval(fetchData, 1000);
</script>
</body>
</html>
    `);
});

// ==================== KHỞI ĐỘNG ====================
app.listen(PORT, () => {
    console.log('Server chạy trên port', PORT);
    loadHistory();
    fetchResults();
    fetchBetData();
    setInterval(fetchBetData, 1000);
    setInterval(fetchResults, 30000);
});
