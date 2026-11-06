import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWebInput } from '../../src/ui/web-url.js';

test('link đầy đủ được giữ nguyên', () => {
  assert.equal(normalizeWebInput('  https://youtu.be/abc?t=5 '), 'https://youtu.be/abc?t=5');
  assert.equal(normalizeWebInput('http://127.0.0.1:8080/a'), 'http://127.0.0.1:8080/a');
});

test('tên miền không có giao thức được thêm https', () => {
  assert.equal(normalizeWebInput('zingmp3.vn'), 'https://zingmp3.vn');
  assert.equal(normalizeWebInput('www.youtube.com/watch?v=x'), 'https://www.youtube.com/watch?v=x');
});

test('tên bài hát chuyển thành tìm kiếm', () => {
  const url = normalizeWebInput('Hà Nội mùa vắng karaoke');
  assert.ok(url.startsWith('https://www.youtube.com/results?search_query='));
  assert.equal(new URL(url).searchParams.get('search_query'), 'Hà Nội mùa vắng karaoke');
  assert.ok(normalizeWebInput('Rap.God karaoke').includes('search_query'));
});

test('giao thức nguy hiểm không bao giờ thành địa chỉ để mở', () => {
  for (const value of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x']) {
    assert.ok(normalizeWebInput(value).startsWith('https://www.youtube.com/results?'), value);
  }
});

test('ô trống hoặc link hỏng không mở gì', () => {
  assert.equal(normalizeWebInput('   '), null);
  assert.equal(normalizeWebInput(null), null);
  assert.equal(normalizeWebInput('https://'), null);
});
