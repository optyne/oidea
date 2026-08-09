import 'package:flutter/material.dart';

class ExcalidrawWebHost extends StatelessWidget {
  const ExcalidrawWebHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  Widget build(BuildContext context) =>
      const Center(child: Text('僅 Web 平台'));
}
