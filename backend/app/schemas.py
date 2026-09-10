from pydantic import BaseModel, ConfigDict


class Record(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class BookSummary(Record):
    id: str
    title: str
    author: str
    created_at: str
    section_count: int


class SectionSummary(Record):
    id: str
    position: int
    spine_position: int
    title: str


class BookDetail(BookSummary):
    sections: list[SectionSummary]


class BlockDetail(Record):
    id: str
    position: int
    kind: str
    heading_level: int | None
    text: str


class SectionDetail(SectionSummary):
    blocks: list[BlockDetail]
