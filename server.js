// server.js
require('dotenv').config(); // .env 파일의 환경 변수를 process.env로 로드 (파일 최상단)

const express = require('express');
const cors = require('cors'); // CORS 미들웨어
const axios = require('axios'); // GitHub API 호출 및 OAuth 토큰 요청에 사용

const app = express();
// .env 파일에서 PORT를 읽고, 없으면 HANDLER_PORT, 그것도 없으면 3003을 기본값으로 사용
const PORT = process.env.PORT || process.env.HANDLER_PORT || 3003;

// .env에서 GitHub 관련 설정값 가져오기
const {
    GITHUB_TOKEN,         // 블로그 콘텐츠 접근 및 관리를 위한 Personal Access Token
    GITHUB_USERNAME,      // GitHub 사용자 이름 (저장소 소유자)
    REPO_NAME,            // GitHub 저장소 이름
    GITHUB_OAUTH_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET,
    GITHUB_OAUTH_REDIRECT_URI
} = process.env;

// Middleware 설정
app.use(cors({
    origin: [
        'http://localhost:50011',         // ★ 로컬 프론트엔드 개발 서버 주소
        'https://note.hanks.kr',         // 운영 프론트엔드 주소
        // 필요한 다른 프론트엔드 출처가 있다면 추가 (예: IP 주소 직접 접근)
        // 'http://39.117.246.63:50011'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // 허용할 HTTP 메소드
    allowedHeaders: ['Content-Type', 'Authorization'],    // 허용할 요청 헤더
    credentials: true // 자격 증명(쿠키 등) 허용 여부
}));
app.use(express.json()); // 요청 본문을 JSON으로 파싱
app.use(express.urlencoded({ extended: true })); // URL-encoded 데이터 파싱

// --- 헬퍼 함수: GitHub API 요청 ---
async function callGitHubApi(method, path, token, data = null, acceptHeader = 'application/vnd.github.v3+json') {
    const url = `https://api.github.com${path}`;
    console.log(`[GitHub API] Calling: ${method} ${url} (Token Used: ${token ? 'Yes' : 'No'}, Accept: ${acceptHeader})`);
    try {
        const response = await axios({
            method: method,
            url: url,
            data: data, // PUT, POST 요청 시 body 데이터
            headers: {
                'Authorization': `token ${token}`,
                'Accept': acceptHeader,
                'User-Agent': 'MyBlogApp-Server/1.0' // GitHub API 권장 사항
            }
        });
        return response; // axios 응답 객체 전체 반환
    } catch (error) {
        const errorMsg = error.response ? JSON.stringify(error.response.data, null, 2) : error.message;
        console.error(`[GitHub API] Error for ${method} ${url}:`, errorMsg);
        if (error.response) {
            const err = new Error(error.response.data.message || 'GitHub API request failed');
            err.status = error.response.status;
            err.data = error.response.data;
            throw err;
        }
        throw error; // 네트워크 오류 등 axios에서 직접 발생한 에러
    }
}

// --- GitHub OAuth 콜백 핸들러 라우트 (/api/auth/github) ---
app.post('/api/auth/github', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ message: "Authorization code is missing." });
    }

    console.log(`[Auth CB] Received OAuth code. Exchanging for token...`);
    console.log(`[Auth CB] Using Client ID: ${GITHUB_OAUTH_CLIENT_ID ? 'Set' : 'NOT SET!'}`);
    console.log(`[Auth CB] Client Secret: ${GITHUB_OAUTH_CLIENT_SECRET ? 'Set (sensitive)' : 'NOT SET - CRITICAL!'}`);
    console.log(`[Auth CB] Using Redirect URI: ${GITHUB_OAUTH_REDIRECT_URI}`);


    if (!GITHUB_OAUTH_CLIENT_ID || !GITHUB_OAUTH_CLIENT_SECRET || !GITHUB_OAUTH_REDIRECT_URI) {
        console.error("[Auth CB] OAuth environment variables are not properly set.");
        return res.status(500).json({ message: "Server OAuth configuration error." });
    }

    try {
        const tokenResponse = await axios.post(
            "https://github.com/login/oauth/access_token",
            {
                client_id: GITHUB_OAUTH_CLIENT_ID,
                client_secret: GITHUB_OAUTH_CLIENT_SECRET,
                code: code,
                redirect_uri: GITHUB_OAUTH_REDIRECT_URI,
            },
            {
                headers: {
                    Accept: "application/json",
                },
            }
        );

        const { access_token, error, error_description } = tokenResponse.data;
        console.log("[Auth CB] GitHub Token Response Data:", tokenResponse.data);


        if (error) {
            console.error("[Auth CB] GitHub OAuth Error:", error, error_description);
            return res.status(400).json({ message: `GitHub OAuth Error: ${error_description || error}` });
        }

        if (!access_token) {
            console.error("[Auth CB] Access token not received from GitHub.");
            return res.status(500).json({ message: "Failed to retrieve access token from GitHub." });
        }

        const userResponse = await axios.get("https://api.github.com/user", {
            headers: {
                Authorization: `token ${access_token}`,
                'User-Agent': 'MyBlogApp-Server/1.0'
            },
        });

        const userData = userResponse.data;
        console.log(`[Auth CB] User ${userData.login} authenticated successfully.`);

        res.status(200).json({
            token: access_token,
            user: {
                login: userData.login,
                avatar_url: userData.avatar_url,
                name: userData.name,
            },
            message: "GitHub authentication successful.",
        });

    } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
        console.error("[Auth CB] Error during GitHub OAuth process:", errorMsg);
        if (err.response && err.response.data && err.response.data.error_description) {
            return res.status(500).json({ message: `GitHub API Error: ${err.response.data.error_description}` });
        }
        res.status(500).json({ message: "An error occurred during the GitHub authentication process." });
    }
});

// --- 글 생성 API 라우트 (/api/create-post) ---
app.post('/api/create-post', async (req, res) => {
    console.log('[API /create-post] Request body:', req.body);
    if (!GITHUB_TOKEN || !GITHUB_USERNAME || !REPO_NAME) {
        console.error("[API /create-post] Server Error: GitHub credentials for post creation not configured.");
        return res.status(500).json({ message: 'Server configuration error for post creation.' });
    }
    try {
        const { targetDir, fileName, commitMessage, fileContent } = req.body;
        if (!targetDir || !fileName || !commitMessage || !fileContent) {
            return res.status(400).json({ message: "Missing required fields for creating post." });
        }

        const path = `/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/${targetDir}/${fileName}`;
        const data = { message: commitMessage, content: Buffer.from(fileContent).toString('base64') };
        
        const githubResponse = await callGitHubApi('PUT', path, GITHUB_TOKEN, data);

        console.log(`[API /create-post] Post created successfully on GitHub: ${fileName}`);
        res.status(githubResponse.status).json({ message: 'Post created successfully on GitHub', data: githubResponse.data });
    } catch (error) {
        const errorMsg = error.data ? JSON.stringify(error.data, null, 2) : error.message;
        console.error('[API /create-post] Error processing request:', errorMsg);
        res.status(error.status || 500).json({ message: `Failed to create post: ${error.data ? error.data.message : error.message}`, errorDetails: error.data });
    }
});

// --- 글 내용 또는 폴더 목록 조회를 위한 공통 핸들러 함수 ---
async function handleGetGitHubContents(req, res, isFileRequestOverride = undefined) {
    const { folder, filename } = req.params;
    const isFile = typeof isFileRequestOverride === 'boolean' ? isFileRequestOverride : !!filename;
    const relativePath = isFile ? `${folder}/${filename}` : folder;

    console.log(`[API /contents] GET for: ${relativePath} (isFile: ${isFile})`);
    if (!GITHUB_TOKEN || !GITHUB_USERNAME || !REPO_NAME) {
        console.error("[API /contents] Server Error: GitHub credentials for fetching content not configured.");
        return res.status(500).json({ message: 'Server configuration error for fetching content.' });
    }

    try {
        const path = `/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/${relativePath}`;
        const acceptHeader = isFile && filename && filename.toLowerCase().endsWith('.md')
            ? 'application/vnd.github.v3.raw'
            : 'application/vnd.github.v3+json';

        const githubResponse = await callGitHubApi('GET', path, GITHUB_TOKEN, null, acceptHeader);

        if (acceptHeader === 'application/vnd.github.v3.raw') {
            console.log(`[API /contents] Fetched raw content for ${relativePath}`);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.status(githubResponse.status).send(githubResponse.data);
        } else {
            console.log(`[API /contents] Fetched JSON content for ${relativePath}`);
            res.status(githubResponse.status).json(githubResponse.data);
        }
    } catch (error) {
        const errorMsg = error.data ? JSON.stringify(error.data, null, 2) : error.message;
        console.error(`[API /contents] Error fetching from GitHub for ${relativePath}:`, errorMsg);
        res.status(error.status || 500).json({ message: `Failed to fetch from GitHub: ${error.data ? error.data.message : error.message}`, errorDetails: error.data });
    }
}

// --- 글/폴더 조회 라우트 ---
app.get('/api/github/contents/:folder/:filename', (req, res) => {
    handleGetGitHubContents(req, res, true); 
});
app.get('/api/github/contents/:folder', (req, res) => {
    handleGetGitHubContents(req, res, false);
});

// --- 글 수정 API 라우트 (/api/update-post) ---
app.post('/api/update-post', async (req, res) => {
    console.log('[API /update-post] Request body:', req.body);
    if (!GITHUB_TOKEN || !GITHUB_USERNAME || !REPO_NAME) {
        console.error("[API /update-post] Server Error: GitHub credentials for post update not configured.");
        return res.status(500).json({ message: 'Server configuration error for post update.' });
    }
    try {
        const { filePath, newContent, commitMessage, sha } = req.body;
        if (!filePath || !newContent || !commitMessage || !sha) {
            return res.status(400).json({ message: "Missing required fields for updating post (filePath, newContent, commitMessage, sha)." });
        }

        const path = `/repos/${GITHUB_USERNAME}/${REPO_NAME}/contents/${filePath}`;
        const data = {
            message: commitMessage,
            content: Buffer.from(newContent).toString('base64'),
            sha: sha
        };

        const githubResponse = await callGitHubApi('PUT', path, GITHUB_TOKEN, data);
        
        const newSha = githubResponse.data && githubResponse.data.content ? githubResponse.data.content.sha : null;
        
        console.log(`[API /update-post] Post updated successfully on GitHub: ${filePath}`);
        res.status(githubResponse.status).json({ 
            message: 'Post updated successfully on GitHub', 
            data: githubResponse.data,
            newSha: newSha 
        });
    } catch (error) {
        const errorMsg = error.data ? JSON.stringify(error.data, null, 2) : error.message;
        console.error('[API /update-post] Error processing request:', errorMsg);
        res.status(error.status || 500).json({ message: `Failed to update post: ${error.data ? error.data.message : error.message}`, errorDetails: error.data });
    }
});

// 기본 라우트 (서버 상태 확인용)
app.get('/', (req, res) => {
    res.send('Blog API Server is up and running!');
});

// 정의되지 않은 모든 경로에 대한 404 처리
app.use((req, res) => {
    console.warn(`[404 Not Found] Path: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ message: 'API Endpoint Not Found' });
});

// 전역 에러 핸들러 (선택 사항이지만 권장)
app.use((err, req, res, next) => {
    console.error("[Global Error Handler] Unhandled error:", err.stack || err);
    res.status(err.status || 500).json({
        message: err.message || "An unexpected server error occurred.",
    });
});

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`  CORS allowed origins include: https://note.hanks.kr (and localhost for dev)`);
    console.log(`  Admin GitHub User: ${GITHUB_USERNAME || 'NOT SET'}`);
    console.log(`  GitHub Repo: ${REPO_NAME || 'NOT SET'}`);
    console.log(`  GitHub Token for server: ${GITHUB_TOKEN ? 'Loaded (sensitive - do not log value)' : 'NOT LOADED - CRITICAL for content ops!'}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`  OAuth Client ID: ${GITHUB_OAUTH_CLIENT_ID || 'NOT SET'}`);
    console.log(`  OAuth Client Secret: ${GITHUB_OAUTH_CLIENT_SECRET ? 'Loaded (sensitive)' : 'NOT LOADED - CRITICAL for OAuth!'}`);
    console.log(`  OAuth Redirect URI: ${GITHUB_OAUTH_REDIRECT_URI || 'NOT SET'}`);
    console.log(`----------------------------------------------------------------`);
});
