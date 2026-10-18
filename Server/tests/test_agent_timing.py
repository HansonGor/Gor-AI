import io
import re
import time
import unittest
from contextlib import redirect_stdout

from agent.agent import _timing


class AgentTimingLogTest(unittest.TestCase):
    def test_timing_line_reports_phase_and_elapsed_ms_only(self):
        started = time.perf_counter() - 0.25
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            _timing("tool", started, tool="web_search", cache_hit="false")
        line = buffer.getvalue().strip()
        self.assertRegex(line, r"^\[Timing\] phase=tool ms=\d+ tool=web_search cache_hit=false$")
        elapsed = int(re.search(r"ms=(\d+)", line).group(1))
        self.assertGreaterEqual(elapsed, 200)

    def test_timing_line_does_not_echo_text_fields(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            _timing("llm", time.perf_counter(), call=2, reason="final_response", tool_calls=0)
        self.assertNotIn("广州", buffer.getvalue())
        self.assertIn("call=2 reason=final_response tool_calls=0", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
