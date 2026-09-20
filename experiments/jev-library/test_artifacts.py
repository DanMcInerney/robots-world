import threading
import unittest

from artifacts import ArtifactWriter


class ArtifactTests(unittest.TestCase):
    def test_close_flushes_and_bounds_pending_work(self):
        seen = []
        with ArtifactWriter(capacity=2) as writer:
            for value in range(9):
                writer.submit(seen.append, value)
        self.assertEqual(seen, list(range(9)))
        self.assertLessEqual(writer.peak_pending, 2)

    def test_worker_errors_prevent_success(self):
        def broken():
            raise OSError('disk unavailable')
        with self.assertRaisesRegex(OSError, 'disk unavailable'):
            with ArtifactWriter() as writer:
                writer.submit(broken)

    def test_backpressure_does_not_discard_work(self):
        completed = threading.Event()
        writer = ArtifactWriter(capacity=1)
        writer.submit(completed.set)
        writer.submit(lambda: None)
        writer.close()
        self.assertTrue(completed.is_set())
        self.assertEqual(writer.peak_pending, 1)


if __name__ == '__main__':
    unittest.main()
