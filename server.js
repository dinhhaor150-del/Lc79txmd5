const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

const HISTORY_FILE = 'history.json';
const MAX_HISTORY = 230;

const API_BET = 'https://lc79txmd5-production.up.railway.app/api/bet';
const API_RESULTS = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=5848a1b6c31c549ee87fa61fd1b3f3f6';

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

// ==================== ĐỌC/GHI ====================
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

// ==================== THUẬT TOÁN MỚI - TỐI ƯU ====================
function analyzeAlgorithm(data, prev) {
    const totalMoney = data.taiAmount + data.xiuAmount;
    if (totalMoney === 0) {
        return { verdict: 'hold', confidence: 30, reason: 'Chưa có dữ liệu', inflowPct: 0.5 };
    }
    
    // Tính dòng tiền mới đổ vào
    let taiInflow = 0.5;
    let inflowStrength = 0;
    
    if (prev && prev.taiAmount && prev.xiuAmount) {
        const deltaTai = data.taiAmount - prev.taiAmount;
        const deltaXiu = data.xiuAmount - prev.xiuAmount;
        const totalDelta = deltaTai + deltaXiu;
        
        if (totalDelta > 0) {
            taiInflow = deltaTai / totalDelta;
            inflowStrength = Math.min(1, totalDelta / totalMoney);
        } else {
            taiInflow = data.taiAmount / totalMoney;
            inflowStrength = 0.3;
        }
    } else {
        taiInflow = data.taiAmount / totalMoney;
        inflowStrength = 0.3;
    }
    
    const xiuInflow = 1 - taiInflow;
    const currentTaiRatio = data.taiAmount / totalMoney;
    const imbalance = Math.abs(currentTaiRatio - 0.5) * 2;
    
    let verdict = 'hold';
    let confidence = 35;
    let reason = '';
    
    // ========== QUY TẮC MỚI: ƯU TIÊN DÒNG TIỀN THỰC ==========
    
    // 1. Dòng tiền mới quá mạnh (>85% đổ 1 cửa) - SIÊU TÍN HIỆU
    if (taiInflow > 0.85 && inflowStrength > 0.05) {
        verdict = 'xiu';
        confidence = 85 + Math.min(10, (taiInflow - 0.85) * 100);
        reason = `💎 SIÊU TÍN HIỆU: ${(taiInflow*100).toFixed(0)}% dòng mới đổ TÀI → XỈU`;
    }
    else if (xiuInflow > 0.85 && inflowStrength > 0.05) {
        verdict = 'tai';
        confidence = 85 + Math.min(10, (xiuInflow - 0.85) * 100);
        reason = `💎 SIÊU TÍN HIỆU: ${(xiuInflow*100).toFixed(0)}% dòng mới đổ XỈU → TÀI`;
    }
    
    // 2. Dòng tiền mới rõ ràng (>70%) - TÍN HIỆU MẠNH
    else if (taiInflow > 0.70) {
        verdict = 'xiu';
        confidence = 72 + (taiInflow - 0.70) * 60;
        reason = `📊 ${(taiInflow*100).toFixed(0)}% dòng mới đổ TÀI → XỈU`;
    }
    else if (xiuInflow > 0.70) {
        verdict = 'tai';
        confidence = 72 + (xiuInflow - 0.70) * 60;
        reason = `📊 ${(xiuInflow*100).toFixed(0)}% dòng mới đổ XỈU → TÀI`;
    }
    
    // 3. Chênh lệch tổng tiền lớn (>20%)
    else if (imbalance > 0.20) {
        if (currentTaiRatio > 0.60) {
            verdict = 'xiu';
            confidence = 65 + imbalance * 50;
            reason = `⚖️ Tài chiếm ${(currentTaiRatio*100).toFixed(0)}% tổng tiền → XỈU`;
        } else if (currentTaiRatio < 0.40) {
            verdict = 'tai';
            confidence = 65 + imbalance * 50;
            reason = `⚖️ Xỉu chiếm ${((1-currentTaiRatio)*100).toFixed(0)}% tổng tiền → TÀI`;
        } else {
            verdict = 'hold';
            confidence = 45;
            reason = `⏳ Chênh lệch ${(imbalance*100).toFixed(0)}% - chưa đủ rõ`;
        }
    }
    
    // 4. Không đủ tín hiệu
    else {
        verdict = 'hold';
        confidence = 35;
        reason = `⏳ Cân bằng - chờ dòng tiền mới (Tài ${(currentTaiRatio*100).toFixed(0)}%)`;
    }
    
    confidence = Math.min(94, Math.max(30, Math.floor(confidence)));
    
    return { verdict, confidence, reason, inflowPct: Math.max(taiInflow, xiuInflow), inflowStrength };
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
            console.log(`🔄 Phiên mới: ${newSid}`);
        } else if (currentSessionId === null) {
            currentSessionId = newSid;
            countdown = 20;
        }
        
        if (!isLocked && currentBetData) {
            const raw = analyzeAlgorithm(currentBetData, prevBetData);
            
            // Bộ lọc - cần 5 mẫu liên tiếp cùng hướng mới chốt
            rawVerdictsBuffer.push({ 
                verdict: raw.verdict, 
                confidence: raw.confidence, 
                inflowPct: raw.inflowPct,
                timestamp: Date.now()
            });
            if (rawVerdictsBuffer.length > 6) rawVerdictsBuffer.shift();
            
            let finalVerdict = raw.verdict;
            let finalConfidence = raw.confidence;
            let finalReason = raw.reason;
            
            // SIÊU TÍN HIỆU: inflow >85% - chốt ngay không cần lọc
            if (raw.inflowPct > 0.85 && raw.inflowStrength > 0.05 && raw.verdict !== 'hold') {
                finalVerdict = raw.verdict;
                finalConfidence = Math.min(94, raw.confidence + 5);
                finalReason = `🔥 ${finalReason}`;
                console.log(`⚡ Siêu tín hiệu! Chốt ngay: ${finalVerdict}`);
            }
            // Lọc thường: cần 5/5 mẫu cùng hướng
            else {
                const last5 = rawVerdictsBuffer.slice(-5);
                if (last5.length === 5 && last5.every(v => v.verdict === last5[0].verdict && v.verdict !== 'hold')) {
                    finalVerdict = last5[0].verdict;
                    finalConfidence = Math.floor(last5.reduce((s, v) => s + v.confidence, 0) / 5);
                    finalReason = `🔒 XÁC NHẬN 5s: ${finalVerdict === 'tai' ? 'XỈU' : 'TÀI'}`;
                    console.log(`✅ Đủ 5 mẫu cùng hướng: ${finalVerdict}`);
                }
                // Chưa đủ 5 mẫu - giữ nguyên nhưng không chốt
                else if (raw.verdict !== 'hold') {
                    finalReason = `${raw.reason} (đang xác nhận... cần ${5 - rawVerdictsBuffer.filter(v => v.verdict === raw.verdict).length}/5)`;
                }
            }
            
            currentPrediction = {
                verdict: finalVerdict,
                confidence: finalConfidence,
                reason: finalReason,
                timestamp: Date.now()
            };
            
            // Chốt nếu đủ điều kiện
            if (finalVerdict !== 'hold' && finalConfidence >= 65 && !isLocked) {
                if (lockPrediction(currentSessionId, finalVerdict, finalConfidence, finalReason)) {
                    isLocked = true;
                    console.log(`🔒 ĐÃ CHỐT: ${finalVerdict} - ${finalReason}`);
                }
            }
        }
        
        // Đếm ngược
        if (!isLocked && countdown > 0) {
            countdown--;
            if (countdown === 0 && !isLocked && currentBetData) {
                const raw = analyzeAlgorithm(currentBetData, prevBetData);
                if (raw.verdict !== 'hold' && raw.confidence >= 55) {
                    lockPrediction(currentSessionId, raw.verdict, raw.confidence, `Hết giờ: ${raw.reason}`);
                } else {
                    const total = currentBetData.taiAmount + currentBetData.xiuAmount;
                    const taiRatio = currentBetData.taiAmount / total;
                    const forced = taiRatio > 0.52 ? 'tai' : 'xiu';
                    lockPrediction(currentSessionId, forced, 50, 'Hết giờ, chốt theo tổng tiền');
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
        statistics: stats,
        recentVerdicts: rawVerdictsBuffer.slice(-5).map(v => v.verdict)
    });
});

app.post('/api/manual-lock', (req, res) => {
    if (!currentBetData || isLocked) {
        return res.json({ success: false, message: 'Không thể chốt' });
    }
    const raw = analyzeAlgorithm(currentBetData, prevBetData);
    if (raw.verdict !== 'hold' && raw.confidence >= 60) {
        const locked = lockPrediction(currentSessionId, raw.verdict, raw.confidence, `Chốt thủ công: ${raw.reason}`);
        if (locked) {
            isLocked = true;
            return res.json({ success: true, verdict: raw.verdict, confidence: raw.confidence });
        }
    }
    res.json({ success: false, message: 'Tín hiệu chưa đủ mạnh (cần >60%)' });
});

app.post('/api/reset-session', (req, res) => {
    if (currentSessionId) {
        const idx = history.findIndex(h => h.sessionId === currentSessionId);
        if (idx !== -1) history.splice(idx, 1);
        saveHistory();
    }
    isLocked = false;
    rawVerdictsBuffer = [];
    countdown = 20;
    res.json({ success: true });
});

app.post('/api/reset-stats', (req, res) => {
    history = [];
    saveHistory();
    res.json({ success: true });
});

// ==================== KHỞI ĐỘNG ====================
app.listen(PORT, () => {
    console.log('🚀 Server chạy trên port', PORT);
    console.log('✅ Thuật toán mới: lọc 5s, siêu tín hiệu >85%');
    loadHistory();
    fetchResults();
    fetchBetData();
    setInterval(fetchBetData, 1000);
    setInterval(fetchResults, 30000);
});
