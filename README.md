# Vokara Studio

Phần mềm chỉnh giọng và biên tập âm thanh trên Windows: chỉnh cao độ trực tiếp khi hát karaoke, sửa từng nốt trong bản thu, biên tập nhiều track và xuất WAV/MP3.

## Chạy

- **Bản đóng gói:** mở `dist/VokaraStudio-win32-x64/VokaraStudio.exe`. Cả thư mục đó là phần mềm, không cần cài đặt; nếu chuyển sang máy khác thì chép nguyên thư mục.
- **Từ mã nguồn:** `npm install`, rồi `npm start`.

## Hát karaoke

1. Đeo tai nghe. Dùng loa ngoài thì tiếng sẽ lọt lại vào mic và hú.
2. Bấm **Bật mic**, rồi **Mở nhạc nền**. Tông nhạc được tự dò. Nếu đặt file `.lrc` cùng tên cạnh file nhạc, lời bài hát sẽ tự hiện.
3. Chọn một **giọng mẫu**, chọn **loại giọng** cho đúng với người hát, rồi bấm **Space** để phát.
4. Bấm nút đỏ (phím **R**) để ghi âm. Khi dừng, chọn **Lưu bản mix** hoặc **Mở trong Biên tập**.

Nút micro ở thanh phát, công tắc ở mục **Mic** hoặc phím **M** bật tắt mic bất cứ lúc nào, trừ khi đang ghi âm.

| Điều khiển | Tác dụng |
|---|---|
| Tốc độ bắt nốt | 0 ms: bẻ nốt tức thì, nghe như robot. 100–200 ms: tự nhiên, giữ luyến láy |
| Mức chỉnh | Kéo về nốt đúng nhiều hay ít |
| Tông / âm giai | Chỉ kéo về các nốt trong tông này. Chọn "Mọi nốt" nếu không biết tông |
| Tông nhạc | Nâng hoặc hạ tông bài hát cho vừa giọng; tông chỉnh giọng đi theo |
| Giảm lời ca gốc | Làm bớt giọng ca nằm chính giữa của bản stereo; không xoá sạch được |

## Nguồn nhạc

Chọn ở thanh **Nguồn nhạc** phía trên màn hát:

| Nguồn | Dùng khi | Nghe và thu |
|---|---|---|
| File nhạc | Có sẵn file âm thanh | Đủ mọi tính năng: đổi tông, đổi tốc độ, giảm lời ca, lời `.lrc` |
| Trang web | Nhạc trên YouTube, Zing MP3, SoundCloud… | Trang chạy ngay trong ứng dụng. Dán link hoặc gõ tên bài vào ô địa chỉ. Nhạc và giọng thu thành track riêng |
| App khác | Spotify, trình duyệt ngoài, trình phát bất kỳ | Bắt toàn bộ âm thanh của loa mặc định. Nhạc vẫn phát từ app đó, nên âm lượng chỉnh ở app đó |

Với hai nguồn trực tiếp, tông giọng tự dò sau khoảng 20 giây nghe nhạc. Đổi tốc độ, giảm lời ca và lời `.lrc` chỉ dùng được với file nhạc.

**Đổi tông nhạc:** có ở File nhạc và Trang web. Với Trang web, thanh **Tông nhạc** có tác dụng ngay khi đang phát, tông chỉnh giọng và bản thu đi theo. Bộ đổi tông làm tiếng nhạc trễ thêm khoảng 85 ms, nên hình trên video có thể sớm hơn tiếng một chút. Với App khác thì không đổi được, vì nhạc đã phát thẳng từ app đó ra loa trước khi Vokara nhận được.

**Thu từ App khác:** Windows trộn tiếng của mọi ứng dụng trước khi cho thu lại, nên không tách được giọng đang phát qua tai.

- Bật **Nghe giọng mình qua tai**: bản thu là nhạc và giọng gộp đúng như bạn nghe. Giọng trong đó trễ nhẹ và không chỉnh riêng được. Các track giọng riêng vẫn có nhưng được tắt sẵn.
- Tắt mục đó: nhạc và giọng thành track riêng, chỉnh được từng phần.
- Cần tách track mà vẫn nghe giọng: dùng nguồn Trang web.

## Biên tập

- **Chọn đoạn:** kéo chuột trên sóng âm. **Alt + kéo:** dịch cả track. **Ctrl + lăn chuột:** phóng to.
- **Phím tắt:** Space phát, Ctrl+X/C/V cắt/chép/dán, Delete làm câm, Ctrl+Z/Y hoàn tác/làm lại, Ctrl+E xuất file.
- **Sửa nốt:** chọn track giọng, bấm **Phân tích giọng**, rồi:
  - **Tự chỉnh về tông** cho cả bài, hoặc cho các nốt đang chọn.
  - Kéo nốt lên xuống. Giữ **Alt** để chỉnh lẻ từng cent; **Shift + bấm** chọn nhiều nốt; bấm đúp để bắt nốt về tông; **↑ ↓** chỉnh từng bán cung.
- Sau khi cắt, dán hay thao tác khác làm đổi sóng âm, các sửa nốt được giữ vào audio; muốn sửa tiếp thì phân tích lại.

## Giới hạn cần biết

- **Độ trễ khi nghe trực tiếp:** khoảng 75–95 ms trên card âm thanh tích hợp, trong đó riêng Windows và card đã chiếm 50–65 ms. Ứng dụng hiện con số ước tính trong mục Mic. Giọng nữ có độ trễ thấp hơn giọng nam vì chu kỳ giọng ngắn hơn. Bản thu được tự căn lại theo độ trễ ước tính, nhưng có thể còn lệch nhẹ; dùng **Alt + kéo** để chỉnh tay.
- **Trang có DRM:** bản Electron này không kèm Widevine, nên Spotify Web, Apple Music, Netflix… không phát được trong khung web. Hãy mở bằng app của họ và dùng nguồn App khác.
- **Đăng nhập trong khung web:** Google có thể từ chối đăng nhập từ trình duyệt nhúng. YouTube vẫn xem được khi không đăng nhập.
- **Bộ tăng cường âm thanh của Windows:** các tuỳ chọn như Loudness Equalization hay phần mềm của Realtek có thể đổi âm lượng của bản thu từ App khác. Tắt chúng nếu bản thu quá to hoặc méo.
- **Bản quyền:** nhạc từ web và app khác chịu điều khoản của nơi cung cấp. Hãy chỉ giữ và chia sẻ bản thu khi được phép.
- **Chưa hỗ trợ:** ASIO, lưu dự án để mở lại, plugin VST, kéo dài hay dời thời gian của từng nốt.

## Kiểm thử

```bash
npm test
```

```bash
npm run test:e2e
```

`npm run test:e2e` có phần phát tiếng thật ra loa khoảng 10 giây để thử nguồn App khác, và cần máy đang im lặng.

`npm test` đo DSP bằng tín hiệu tổng hợp. `npm run test:e2e` chạy Electron thật, dùng file WAV thay cho mic, và kiểm tra cả thao tác chuột, phím; kết quả và ảnh chụp nằm ở `test/e2e/output/`.

Đóng gói lại:

```bash
npm run package
```

## Giấy phép thành phần

Mã MP3 dùng [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0), nằm ở `src/vendor/lame.min.js`.
