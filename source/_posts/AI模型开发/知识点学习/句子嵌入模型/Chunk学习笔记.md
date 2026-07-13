---
title: "Chunk 越小，检索就越准吗？从边界切断到重复召回讲清 RAG 切块"
date: 2026-07-13 18:21:47
updated: 2026-07-13 18:21:47
categories:
  - "学习"
  - "AI 模型开发"
  - "知识点学习"
  - "句子嵌入模型"
permalink: /notes/ai模型开发/知识点学习/句子嵌入模型/chunk学习笔记/
series: "AI 模型开发"
---

做 RAG 时，一个很常见的调参思路是：召回不准，就把文档切得更小。

这个办法有时有效，有时却会让结果更差：标题和正文分家，解释只剩半句，相邻块又因为重叠而高度相似，最终 `top-k` 看似召回了 5 条，实际只有 1 条信息。

问题不在于 chunk 是否足够小，而在于它能否同时完成两件事：

1. 作为检索单元时，主题足够集中；
2. 作为回答证据时，上下文足够完整。

本文从这个矛盾出发，给出一份可运行的 Markdown 切块基线，并说明怎样用真实查询评估 `chunk size` 和 `overlap`，而不是照抄一组固定数字。

## 一、为什么整篇文档和一句话都不是理想的检索单元

假设一篇网络服务文档同时介绍普通 HTTP 响应、SSE 流式响应和 WebSocket。若把整篇文章编码成一个向量，三个主题会被压进同一个表示中。用户搜索“断线后怎样恢复 SSE”，相关段落可能被其他内容稀释。

反过来，若每句话都是一个 chunk，检索可能只得到：

> 客户端重新连接时可以携带该值。

这句话缺少前文，无法知道“该值”是 `Last-Event-ID`，也无法直接支撑回答。

因此，chunk 不是排版上的一段文字，而是检索系统中的最小证据单元。好的 chunk 通常具备以下特征：

- 围绕一个相对集中的问题或主题；
- 保留理解该主题所需的限定条件；
- 长度没有超过 embedding 模型的有效输入范围；
- 能回溯到原文位置、标题层级和文档版本；
- 与相邻 chunk 不会重复到占满检索结果。

这也解释了为什么换 embedding 模型不一定能救回糟糕的切块：模型只能表示收到的文本，无法恢复在切分时已经丢掉的上下文。

## 二、先看一个会切坏语义的实现

最简单的固定长度切块只有一行核心逻辑：

```python
def naive_chunks(text: str, size: int = 100) -> list[str]:
    return [text[i:i + size] for i in range(0, len(text), size)]
```

它适合作为冒烟测试，却有三个明显问题：

1. 边界可能落在句子、代码块或表格中间；
2. 标题没有随正文进入检索文本；
3. 只有切片结果，没有原文偏移、稳定 ID 和版本信息。

工程上更稳妥的起点通常是“结构优先，长度兜底”：先按标题、条款、问答或接口等自然结构分组，只有某一组过长时才继续切分。

## 三、常见策略不是互斥选项

| 策略 | 优点 | 主要风险 | 常见场景 |
| --- | --- | --- | --- |
| 固定长度 | 实现简单，长度可控 | 容易切断语义边界 | 无稳定结构的原始文本、第一版基线 |
| 段落切分 | 边界自然，可读性好 | 段落可能极长或极短 | 博客、说明文档、会议记录 |
| 标题切分 | 能保留主题层级 | 长小节仍需二次切分 | 技术文档、教程、知识库 |
| 业务结构切分 | 检索单元与用户问题一致 | 需要针对文档类型解析 | FAQ、API、合同条款、代码 |
| 语义切分 | 可发现没有显式标记的主题变化 | 成本更高，阈值也要评估 | 结构较弱且主题跳转明显的长文本 |

真实项目往往使用混合方案：先利用文档结构，再按句子边界控制长度；必要时用少量 overlap 保护边界。

## 四、可运行示例：带标题路径、偏移和稳定 ID 的 Markdown 切块器

下面的程序只使用 Python 标准库，可在 Python 3.9 及以上版本运行。它是一份便于理解和做对照实验的**字符级基线**，不是完整的 Markdown 解析器，也不是线上 token 配额器。

将代码保存为 `chunk_demo.py` 后运行：

```bash
python3 chunk_demo.py
```

```python
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
BOUNDARIES = set("\n。！？；.!?;")

@dataclass(frozen=True)
class Section:
    path: tuple[str, ...]
    text: str

@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    document_id: str
    ordinal: int
    section_path: tuple[str, ...]
    section_start: int
    section_end: int
    text: str
    content_sha256: str

def parse_markdown_sections(markdown: str) -> list[Section]:
    """按 ATX 标题拆分 Markdown，并保留完整标题路径。"""
    sections: list[Section] = []
    headings: list[str] = []
    body: list[str] = []
    current_path = ("document",)

    def flush() -> None:
        text = "\n".join(body).strip()
        if text:
            sections.append(Section(current_path, text))

    for line in markdown.splitlines():
        match = HEADING_RE.match(line)
        if not match:
            body.append(line)
            continue

        flush()
        body.clear()

        level = len(match.group(1))
        title = match.group(2)
        headings[:] = headings[: level - 1]
        while len(headings) < level - 1:
            headings.append("(untitled)")
        headings.append(title)
        current_path = tuple(headings)

    flush()
    return sections

def choose_end(text: str, start: int, max_chars: int) -> int:
    """在长度上限之前，优先选择较近的句末或换行。"""
    hard_end = min(start + max_chars, len(text))
    if hard_end == len(text):
        return hard_end

    search_floor = start + max(1, max_chars // 2)
    for end in range(hard_end, search_floor, -1):
        if text[end - 1] in BOUNDARIES:
            return end
    return hard_end

def align_ascii_start(text: str, start: int) -> int:
    """避免 overlap 从 Last-Event-ID 一类 ASCII 标识符中间开始。"""
    identifier_chars = set("-_/.:")
    while (
        0 < start < len(text)
        and (text[start - 1].isalnum() or text[start - 1] in identifier_chars)
        and (text[start].isalnum() or text[start] in identifier_chars)
    ):
        start -= 1
    return start

def split_long_section(
    text: str,
    max_chars: int,
    overlap_chars: int,
) -> list[tuple[int, int, str]]:
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    if not 0 <= overlap_chars < max_chars:
        raise ValueError("overlap_chars must be in [0, max_chars)")

    pieces: list[tuple[int, int, str]] = []
    start = 0
    while start < len(text):
        end = choose_end(text, start, max_chars)
        piece = text[start:end].strip()
        if piece:
            pieces.append((start, end, piece))
        if end == len(text):
            break

        next_start = align_ascii_start(text, end - overlap_chars)
        start = next_start if next_start > start else end

    return pieces

def make_chunk_id(
    document_id: str,
    path: tuple[str, ...],
    start: int,
    end: int,
    text: str,
) -> str:
    identity = "\0".join(
        [document_id, " > ".join(path), str(start), str(end), text]
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return f"chk-{digest[:16]}"

def chunk_markdown(
    markdown: str,
    document_id: str,
    max_chars: int = 120,
    overlap_chars: int = 20,
) -> list[Chunk]:
    chunks: list[Chunk] = []

    for section in parse_markdown_sections(markdown):
        for start, end, text in split_long_section(
            section.text, max_chars, overlap_chars
        ):
            chunks.append(
                Chunk(
                    chunk_id=make_chunk_id(
                        document_id, section.path, start, end, text
                    ),
                    document_id=document_id,
                    ordinal=len(chunks),
                    section_path=section.path,
                    section_start=start,
                    section_end=end,
                    text=text,
                    content_sha256=hashlib.sha256(
                        text.encode("utf-8")
                    ).hexdigest(),
                )
            )

    return chunks

def text_for_embedding(chunk: Chunk) -> str:
    """标题路径也参与向量化，避免正文失去主题。"""
    path = " > ".join(chunk.section_path)
    return f"标题路径：{path}\n正文：{chunk.text}"

if __name__ == "__main__":
    document = """# 网络服务

## 普通响应

普通 HTTP 响应会在服务端准备好响应体后一次性返回。它实现简单，适合内容较短、无需增量展示的请求。

## SSE 流式响应

SSE 通过 text/event-stream 持续发送事件。服务端应按事件格式输出 data 字段，并用空行结束一个事件。

需要恢复连接时，服务端可以发送 id 字段。浏览器重新连接时会携带 Last-Event-ID，服务端据此决定从哪里继续发送。
"""

    result = chunk_markdown(
        document,
        document_id="network-service-v1",
        max_chars=80,
        overlap_chars=12,
    )

    # 相同输入和配置应产生相同 ID，方便重复导入时幂等更新。
    repeated = chunk_markdown(
        document,
        document_id="network-service-v1",
        max_chars=80,
        overlap_chars=12,
    )
    assert [c.chunk_id for c in result] == [c.chunk_id for c in repeated]
    assert all(len(c.text) <= 80 for c in result)
    assert len({c.chunk_id for c in result}) == len(result)

    for chunk in result:
        preview = text_for_embedding(chunk).replace("\n", " | ")
        print(
            json.dumps(
                {
                    **asdict(chunk),
                    "embedding_preview": preview,
                },
                ensure_ascii=False,
            )
        )
```

这份实现解决了固定切片最容易遗漏的几件事：

- `section_path` 保存完整标题路径，正文不会脱离主题；
- `section_start` 和 `section_end` 保存小节内偏移，可用于定位原文；
- `chunk_id` 由文档、路径、位置和内容共同生成，相同输入可重复得到相同 ID；
- `content_sha256` 可用于识别内容变化或辅助去重；
- 长小节优先在句号、分号或换行处结束，实在找不到才硬切。

这里的“稳定 ID”是相对于**相同文档 ID、内容和切块配置**而言。若在开头插入一段文字，后续偏移改变，ID 也会改变。生产系统应同时保存 `document_version`、`parser_version` 和 `chunker_version`，不要把稳定误解为永远不变。

### 这份示例刻意没有解决什么

正则表达式无法完整解析 Markdown。围栏代码中的 `#`、表格、HTML 块、嵌套列表和引用都可能需要专门处理。若文档大量包含这些结构，应使用项目已有的 Markdown AST 解析器，不要不断给正则打补丁。

此外，示例按字符计数。它适合演示边界策略和建立第一版 baseline，但线上必须按实际 embedding tokenizer 再做长度校验。

## 五、字符数为什么不能直接等于 token 数

模型限制的是 token，而不是 Python 的 `len(text)`。同样 300 个字符，中文、英文、代码、URL 和混合文本可能得到明显不同的 token 数；tokenizer 还可能添加模型需要的特殊 token。

稳妥的流程是：

1. 使用与 embedding 模型匹配的 tokenizer；
2. 对真正送入模型的完整字符串计数，包括标题前缀和模板；
3. 为特殊 token 和后续模板留出余量；
4. 记录被截断的 chunk 数量，不能让截断静默发生。

Sentence Transformers 暴露了 `max_seq_length`，超过该长度的输入会被截断。这个数是硬边界，不是推荐把每个 chunk 都塞满的目标。chunk 越接近上限，主题越可能混杂，推理开销也通常更高。

Hugging Face tokenizer 提供 `truncation`、`max_length`、`stride` 和 `return_overflowing_tokens` 等参数。使用 fast tokenizer 时，`return_offsets_mapping` 还能把 token 映射回字符区间。若用这些能力替换字符级窗口，需要继续检查两件事：标题路径是否随每个窗口进入模型，以及 token 窗口是否切坏代码或业务结构。

参考官方文档：

- [Hugging Face Transformers：Tokenizer](https://huggingface.co/docs/transformers/main_classes/tokenizer)
- [Sentence Transformers：SentenceTransformer](https://sbert.net/docs/package_reference/sentence_transformer/model.html)
- [Sentence Transformers：计算向量与输入长度](https://sbert.net/examples/sentence_transformer/applications/computing-embeddings/)

## 六、Overlap 不是免费的上下文

重叠的作用是保护边界。例如定义恰好出现在 chunk 末尾，而解释落在下一个 chunk 中，少量 overlap 能让两者至少在一个检索单元里共同出现。

但 overlap 太大时，相邻向量高度相似，可能同时进入 `top-k`：

```text
top-1  SSE 断线恢复：包含 id 和 Last-Event-ID
top-2  SSE 断线恢复：几乎相同，只向后多了一句
top-3  SSE 断线恢复：再次重复
```

此时 `top-3` 实际只提供了一份证据，还挤掉了其他相关章节。若窗口大小为 `S`、重叠为 `O`，后续窗口每次只前进 `S - O`。当 `O` 接近 `S` 时，chunk 数量、向量存储和重复召回都会迅速增加。

所以，“重叠 10%～20%”只能当实验起点，不能当通用标准。更好的选择取决于边界风险：

- 标题和段落边界已经可靠时，可以不重叠或少重叠；
- 句子容易跨窗口时，再加入少量重叠；
- 检索后按 `doc_id + 相邻 ordinal` 扩展上下文，可减少索引阶段的重复；
- 父子 chunk 模式可用小块检索，再返回较完整的父块；
- 返回结果应按内容哈希、相似度或相邻区间做去重。

不要只看召回率。还要观察 `top-k` 中近重复结果的比例，以及去重后还剩多少独立证据。

## 七、不同文档应尊重不同的“天然答案边界”

| 文档类型 | 优先边界 | 必须保留的信息 |
| --- | --- | --- |
| FAQ | 一问一答 | 问题、答案、分类 |
| API 文档 | 一个端点或一个操作 | 方法、路径、参数、返回值、错误码 |
| 教程与博客 | 标题、小节、段落 | 完整标题路径、代码与解释的对应关系 |
| 合同与法规 | 章、条、款、项 | 编号、上位条款、版本和生效时间 |
| PDF 报告 | 章节、段落、页面区域 | 页码、版面顺序、表题和图题 |
| 源代码 | 函数、类、模块 | 符号名、文件路径、必要的注释和签名 |
| 表格 | 表头与一组相关行 | 列名、单位、主键，不能只留下数据行 |

例如 API 文档不应机械地把“参数表”和接口路径拆开；代码示例也不应与解释它的段落分离。所谓语义完整，并不等于必须很长，而是该 chunk 能独立回答某一类问题。

## 八、元数据决定 chunk 能否真正上线

向量文本只负责语义匹配，真实系统还需要元数据完成过滤、权限、更新、引用和追踪。常见字段可以分为四类：

- 身份：`chunk_id`、`document_id`、`document_version`、`ordinal`；
- 定位：标题路径、原文偏移、页码、URL、文件路径；
- 处理过程：`parser_version`、`chunker_version`、token 数、内容哈希；
- 业务属性：语言、时间、租户、访问权限、文档类型。

尤其不要在向量库里只保存 `text` 和 `source`。文档更新后，如果无法判断旧 chunk 属于哪个版本，就很容易出现新旧内容同时被召回的问题。

标题路径既应作为元数据用于展示，也常常应拼入 embedding 文本。只存元数据但不参与向量化，模型就无法利用“流式响应”“错误处理”这些高价值检索信号。

## 九、怎样用实验选 chunk size，而不是凭感觉

切块质量不能脱离检索任务单独评分。一个可复现的小型实验可以这样设计。

### 1. 建立问题与证据集

从真实日志或典型场景中选择问题，并标出能回答问题的原文证据区间。例如：

```json
{
  "query": "SSE 断线后怎样从上次位置继续？",
  "document_id": "network-service-v1",
  "evidence": [[186, 268]]
}
```

证据最好标原文区间，而不是提前绑定某个 chunk ID，否则更换切块策略后标签会失效。

### 2. 只改变切块策略

固定 embedding 模型、索引参数、查询集、reranker 和 `top-k`，分别测试：

- 结构切分，无 overlap；
- 结构切分，小 overlap；
- 较小窗口；
- 较大窗口；
- 小块检索后扩展相邻块。

如果一次同时更换模型和 chunk 参数，就无法判断提升来自哪里。

### 3. 同时观察召回、冗余和回答

建议至少记录：

- `Recall@k`：前 k 个结果是否覆盖标注证据；
- `MRR`：第一条正确证据出现得是否足够靠前；
- 重复率：前 k 条中有多少是相邻或近重复 chunk；
- 截断率：有多少 chunk 超过模型有效输入并被截断；
- 证据完整性：召回片段能否独立支撑答案；
- 最终回答正确率与引用准确率。

同时统计 chunk token 长度的中位数、P95 和最大值。只看平均长度会掩盖少数超长小节。

### 4. 阅读 bad case

指标只能告诉你哪里变差，样例才能说明为什么变差：

- 完全召回不到，可能是主题被大块稀释，也可能是查询与文档用词不同；
- 命中但答不出，可能是块太碎或关联表头丢失；
- 结果高度重复，通常要检查 overlap 和去重；
- 标题相关而正文无关，可能是小节边界或标题继承错误。

最终选择应基于目标查询分布，而不是“中文固定 300～500 字”这类经验数字。经验值适合启动实验，不适合结束实验。

## 十、最容易踩的六个坑

### 1. 清洗之后才发现偏移失效

若先记录原文偏移，再删除页眉、合并空白，偏移就不再指向原文。应明确偏移基于原始文本还是规范化文本，并保存二者之间的映射或可追踪标识。

### 2. 标题只放在数据库字段里

过滤和展示能看到标题，不代表 embedding 模型也看到了标题。需要明确构造实际的 embedding 输入。

### 3. 依赖模型自动截断

自动截断能避免报错，却可能悄悄删掉 chunk 后半段的关键证据。索引前应主动计数并记录异常。

### 4. 为保护一句话而复制半篇文章

大 overlap 往往只是掩盖边界策略的问题。先改进结构切分，再决定是否需要重叠。

### 5. 把所有文件当普通段落

表格、代码、FAQ 和合同的语义边界不同。统一字符窗口容易破坏它们最重要的上下文。

### 6. 文档更新时只新增，不删除旧块

重新切块后，必须按文档版本替换或清理旧索引，否则检索结果会混合过期内容。更新策略属于 chunk 生命周期的一部分。

## 十一、一个务实的落地顺序

第一次为知识库实现 chunking 时，可以按下面的顺序推进：

1. 清理明确的页眉、页脚和导航噪声，并保留来源映射；
2. 按文档已有结构形成候选小节；
3. 用与 embedding 模型一致的 tokenizer 检查真实输入长度；
4. 只对超长小节二次切分，初始 overlap 保持克制；
5. 保存标题路径、原文定位、内容哈希和处理版本；
6. 建立小规模问题—证据集，对比不同参数；
7. 从 bad case 决定是调整窗口、扩展邻居，还是改用父子 chunk；
8. 上线后监控截断、重复召回和文档更新残留。

简单结构良好的小型知识库，不必一开始就引入语义切分或复杂框架。本文的结构加长度兜底方案已经能作为清晰的 baseline；只有实验表明确实受限于边界，才增加复杂度。

## 总结

Chunking 的目标不是把文档尽量切小，而是构造“可检索、可理解、可追踪”的证据单元。

真正需要平衡的是三件事：块太大会稀释主题，块太小会丢失上下文，重叠太多又会制造重复召回。先尊重标题、问答、条款、函数等天然结构，再用模型对应的 tokenizer 控制长度，最后通过真实问题和证据区间评估，才比照抄固定字数更可靠。

可以用一句话记住：

> 结构决定在哪里切，模型决定最多切多长，评测决定参数是否合适。
