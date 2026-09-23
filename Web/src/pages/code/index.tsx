import { useState } from 'react';

const PRESET_TESTS: { name: string; code: string; desc: string }[] = [
  {
    name: '我是谁',
    desc: '看沙箱里的系统信息',
    code: `import platform, os
print("🏠 容器 ID:", os.uname().nodename)
print("💻 系统:", platform.system(), platform.release())
print("🐍 Python:", platform.python_version())
print("📁 当前目录:", os.getcwd())
print("📂 目录下文件:", os.listdir('.')[:10])`,
  },
  {
    name: '访问 D 盘',
    desc: '尝试读你电脑的文件',
    code: `import os
try:
    files = os.listdir('/mnt/d')[:5]
    print("✅ 能访问 /mnt/d:", files)
except Exception as e:
    print("❌ 不能访问 /mnt/d:", e)

try:
    with open('/mnt/d/Gor/Web/package.json') as f:
        print("✅ 读到了你的项目:", f.read()[:100])
except Exception as e:
    print("❌ 读不到你的项目:", e)`,
  },
  {
    name: '死循环',
    desc: '看会不会卡死电脑',
    code: `print("开始死循环...")
while True:
    pass`,
  },
  {
    name: '写文件',
    desc: '写完再跑一次，文件还在吗',
    code: `with open('/box/test.txt', 'w') as f:
    f.write('我是沙箱里写的文件')
print("写好了 /box/test.txt")
# 下次跑这个代码时，文件就没了（每次都是全新容器）`,
  },
];

export default function CodeDemoPage() {
  const [code, setCode] = useState(PRESET_TESTS[0].code);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const runCode = async (customCode?: string) => {
    const finalCode = customCode ?? code;
    setLoading(true);
    setResult(null);
    try {
      const resp = await fetch('http://localhost:3001/api/judge/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_code: finalCode,
          language_id: 71,
          stdin: '',
        }),
      });
      const data = await resp.json();
      setResult(data);
    } catch (e: any) {
      setResult({ status: '请求失败', stderr: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f0f19',
      color: '#fff',
      padding: '20px',
      fontFamily: 'monospace',
      maxWidth: '800px',
      margin: '0 auto',
    }}>
      <h2 style={{ marginBottom: '4px' }}>Gor 代码沙箱 Demo</h2>
      <p style={{ color: '#888', fontSize: '13px', marginBottom: '20px' }}>
        下面点几个按钮，直观感受代码是在隔离沙箱里跑的
      </p>

      {/* 快捷测试按钮 */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {PRESET_TESTS.map((t) => (
          <button
            key={t.name}
            onClick={() => { setCode(t.code); runCode(t.code); }}
            disabled={loading}
            style={{
              background: 'rgba(124,92,252,0.15)',
              color: '#b8a5ff',
              border: '1px solid rgba(124,92,252,0.3)',
              borderRadius: '20px',
              padding: '8px 16px',
              fontSize: '13px',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* 代码编辑区 */}
      <div style={{ marginBottom: '16px' }}>
        <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>Python 代码：</label>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{
            width: '100%',
            height: '200px',
            background: '#1a1a2e',
            color: '#e0e0e0',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            padding: '12px',
            fontFamily: 'monospace',
            fontSize: '14px',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* 运行按钮 */}
      <button
        onClick={() => runCode()}
        disabled={loading}
        style={{
          background: loading ? '#555' : '#7c5cfc',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          padding: '10px 24px',
          fontSize: '14px',
          cursor: loading ? 'not-allowed' : 'pointer',
          marginBottom: '20px',
        }}
      >
        {loading ? '执行中...' : '运行代码'}
      </button>

      {/* 结果区 */}
      {result && (
        <div style={{
          background: '#1a1a2e',
          borderRadius: '8px',
          padding: '16px',
          border: '1px solid rgba(255,255,255,0.1)',
        }}>
          <div style={{ marginBottom: '8px', color: '#888' }}>
            状态: <span style={{ color: result.status_id === 3 ? '#52c41a' : '#ff4d4f' }}>{result.status}</span>
            {result.time && <span style={{ marginLeft: '16px' }}>耗时: {result.time}s</span>}
            {result.memory && <span style={{ marginLeft: '16px' }}>内存: {result.memory} KB</span>}
          </div>

          {result.stdout && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ color: '#888', marginBottom: '4px' }}>stdout:</div>
              <pre style={{ margin: 0, color: '#52c41a', whiteSpace: 'pre-wrap' }}>{result.stdout}</pre>
            </div>
          )}

          {result.stderr && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ color: '#888', marginBottom: '4px' }}>stderr:</div>
              <pre style={{ margin: 0, color: '#ff4d4f', whiteSpace: 'pre-wrap' }}>{result.stderr}</pre>
            </div>
          )}

          {result.message && (
            <div style={{ color: '#faad14', fontSize: '12px' }}>message: {result.message}</div>
          )}
        </div>
      )}
    </div>
  );
}
