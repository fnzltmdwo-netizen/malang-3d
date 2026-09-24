# 말랑 3D 스튜디오

인물 사진 한 장 → 3D 애니메이션 캐릭터 → 이미지 저장/공유.
**관리자가 /admin 에서 OpenAI 키를 한 번 넣으면, 방문자는 사진만 올리면 됩니다.**
외부 패키지 없음 (Node 18+ 내장 기능만).

## 로컬 실행
```bash
node server.js
# 사이트   http://localhost:3000
# 관리자   http://localhost:3000/admin   (기본 비밀번호 admin1234)
```
관리자 페이지에서 OpenAI 키 저장 → 끝.

## Render에 올리기 (무료, 5분)
1. https://dashboard.render.com → **New +** → **Blueprint** → 이 저장소 선택 (`render.yaml`이 설정을 다 갖고 있어요)
2. 환경변수 입력창이 뜨면:
   - `ADMIN_PASSWORD` = 관리자 비밀번호 (원하는 걸로)
   - `OPENAI_API_KEY` = OpenAI 키 (관리자 페이지에서도 넣을 수 있지만, 여기 넣어두면 서버 재시작 후에도 유지됨)
3. **Apply** → 1~2분 뒤 `https://malang-3d-studio.onrender.com` 생성
4. `주소/admin` 에서 로그인해 하루 제한·품질 설정

## 관리자 페이지 기능
- OpenAI 키 등록/변경 (마스킹 표시)
- 하루 최대 변환 수, 1인(IP)당 시간당 최대 변환 수 → 요금 폭탄 방지
- 이미지 품질 low/medium/high (장당 약 $0.02 / $0.05 / $0.17)
- 오늘·누적 변환 수와 예상 비용

## 참고
- Render 무료 플랜은 15분 동안 아무도 안 쓰면 잠들었다가 첫 접속 때 30초쯤 걸려 깨어남
- 무료 플랜은 재시작 시 `config.json`이 사라짐 → 키는 환경변수 `OPENAI_API_KEY`에 넣어두는 걸 권장
- gpt-image-1은 OpenAI 조직 인증(Verify Organization)이 필요
- 스타일 추가: `server.js`의 `STYLES`에 프롬프트 추가 + `public/index.html`에 같은 이름의 버튼 추가
