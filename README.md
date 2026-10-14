# Binance Lite (바이낸스 라이트)

Binance USD-M 선물 대시보드 — 포지션·시나리오·지갑(Spot/Earn)·AI 채팅.  
**AWS EC2 프리 티어에서 24시간** 돌리기 위한 배포 구성 포함.

원본 로컬 앱(`binance`)에서 분리한 별도 저장소입니다. **시크릿(`.env`)은 커밋하지 마세요.**

## 로컬

```bash
cp .env.example .env   # BINANCE_API_KEY / SECRET 등
npm ci
npm run dev            # http://127.0.0.1:3000
```

프로덕션 모드:

```bash
npm run build
npm start              # NODE_ENV=production, dist 서빙
```

## AWS EC2 프리 티어 (권장)

| 항목 | 권장 |
|------|------|
| 인스턴스 | `t2.micro` / `t3.micro` (프리 티어) |
| OS | Ubuntu 22.04 LTS 또는 Amazon Linux 2023 |
| 스토리지 | 8–20 GB gp3 |
| 보안 그룹 | **본인 IP만** TCP `3000` (또는 Nginx `80/443`) |
| Node | 20+ |

### 1) 인스턴스 생성 후

```bash
# 예: Ubuntu
git clone https://github.com/<YOU>/binance-lite.git ~/binance-lite
cd ~/binance-lite
chmod +x deploy/ec2-setup.sh
# REPO_URL은 이미 clone 했으면 생략
./deploy/ec2-setup.sh
nano .env   # 키 입력, LISTEN_HOST=0.0.0.0
npm run build
sudo systemctl restart binance-lite
```

### 2) 바이낸스 API

- Enable **Futures** (+ Spot/Earn 읽기 필요 시 해당 권한)
- IP 제한: EC2 **Elastic IP / 공인 IP** 등록  
  (`curl -s https://api.ipify.org`)
- 집 IP와 분리하면 로컬 밴과 무관하게 EC2에서 조회 가능

### 3) IP 밴 완화 (이미 코드 반영)

- 지갑 overview 캐시·상세 클릭 시만·순차 호출
- `data/binance_ban_until` 에 밴 시각 저장 → **재시작해도** 밴 중 REST를 안 침
- `VITE_ENABLE_USER_TRADES_SYNC=false` 유지 권장

밴 중에는 UI 폴링을 줄이거나 서비스를 잠시 멈추세요. 재시도하면 밴이 늘어납니다.

### systemd

유닛: `deploy/binance-lite.service`  
로그: `journalctl -u binance-lite -f`

## 환경 변수

`.env.example` 참고. 최소:

- `BINANCE_API_KEY` / `BINANCE_API_SECRET`
- EC2: `LISTEN_HOST=0.0.0.0`, `PORT=3000`
- AI(선택): `GEMINI_API_KEY` 등
- Jupiter 잔고(선택): `JUPITER_WALLET` — 공개 주소. 바이낸스 담보 합계에는 넣지 않음

## 라이선스 / 주의

개인 사용 목적. API 키·주문 권한이 있으니 보안 그룹을 넓게 열지 마세요.  
투자 조언이 아니며, REST 과다 사용 시 바이낸스 IP 제한이 걸립니다.
